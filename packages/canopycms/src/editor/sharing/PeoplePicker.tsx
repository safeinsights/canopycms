'use client'

import React, { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Avatar, Combobox, Group, Loader, Text, TextInput, useCombobox } from '@mantine/core'
import { IconMail, IconUsers } from '@tabler/icons-react'

import type { FindPeopleResult } from '../../api/people'
import type { ApiErrorCode } from '../../api/types'
import { accessRefusalMessage } from '../copy'
import { useApiClient } from '../context/ApiClientContext'
import {
  entryKey,
  looksLikeEmail,
  personToAdd,
  type Addition,
  type BranchAccess,
} from './share-staging'
import { isLockout } from './useBranchAccess'

const SEARCH_DELAY_MS = 300
const MIN_NAME_QUERY = 2

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * Why an exact address found no one. Find also skips anyone listed, removed or asking, so the copy
 * claims nothing about whether an account exists.
 */
const emailNotFoundMessage = (scope: BranchAccess['addableByEmail']): string =>
  scope === 'cms-users'
    ? 'No one who works in this editor was found for that address, or they already have access or were removed.'
    : 'No one found for that address, or they already have access or were removed. Someone new signs in to the editor once, then can be found about 15 minutes later.'

const NO_NAME_MATCH = 'No one found. Type their full email address to add them.'

export interface PeoplePickerProps {
  branch: string
  searchable: BranchAccess['searchable']
  addableByEmail: BranchAccess['addableByEmail']
  /** Keys (`entryKey`) of entries already staged, which the picker no longer offers. */
  staged: ReadonlySet<string>
  onAdd: (addition: Addition) => void
  /** A refusal no change to the picker can pass, such as losing access to the branch. */
  onRefused: (code: ApiErrorCode) => void
  announce: (message: string) => void
  inputRef: RefObject<HTMLInputElement>
  /** Why the picker can't be used yet; it is disabled while set. */
  disabledReason?: string
}

/**
 * The Share dialog's search: suggestions while empty, people by name from two characters, and one
 * "Add ‹email›" option for an address, which is looked up only once picked, sparing the email
 * lookup limit. While open the list always shows something, since Mantine marks the input
 * `data-mantine-stop-propagation` then, so Esc closes the list and never the dialog behind it.
 */
export function PeoplePicker({
  branch,
  searchable,
  addableByEmail,
  staged,
  onAdd,
  onRefused,
  announce,
  inputRef,
  disabledReason,
}: PeoplePickerProps) {
  const client = useApiClient()
  const combobox = useCombobox({ onDropdownClose: () => combobox.resetSelectedOption() })
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<{ query: string; result: FindPeopleResult } | null>(null)
  const [failedQuery, setFailedQuery] = useState<string | null>(null)
  const [lookingUp, setLookingUp] = useState(false)
  const [fieldError, setFieldError] = useState<string>()
  const seq = useRef(0)
  const lookingUpRef = useRef(false)

  const trimmed = query.trim()
  const isEmail = looksLikeEmail(trimmed)
  const searchesNames = searchable !== 'nobody' && !isEmail && trimmed.length >= MIN_NAME_QUERY
  const searches = trimmed === '' || searchesNames
  const opened = combobox.dropdownOpened

  const find = async (text: string) => {
    const result = await client.branches.findPeople({ branch }, { query: text })
    if (!result.ok && isLockout(result.code)) onRefused(result.code)
    return result
  }

  useEffect(() => {
    // Bumped even when nothing is read, so an older read's late answer is never shown.
    const mine = ++seq.current
    if (!searches || (trimmed === '' && !opened)) return
    if (found?.query === trimmed) return
    const timer = setTimeout(
      () => {
        find(trimmed)
          .then((result) => {
            if (mine !== seq.current) return
            if (!result.ok || !result.data) {
              setFailedQuery(trimmed)
              if (result.code === 'RATE_LIMITED') setFieldError(accessRefusalMessage(result.code))
              return
            }
            setFailedQuery(null)
            setFound({ query: trimmed, result: result.data })
            if (trimmed) {
              const { people, groups } = result.data
              announce(
                groups.length > 0
                  ? `${plural(people.length, 'person', 'people')} and ${plural(groups.length, 'group', 'groups')} found`
                  : `${plural(people.length, 'person', 'people')} found`,
              )
            }
          })
          .catch((err: unknown) => {
            console.error(err)
            if (mine === seq.current) setFailedQuery(trimmed)
          })
      },
      trimmed === '' ? 0 : SEARCH_DELAY_MS,
    )
    return () => clearTimeout(timer)
    // `find` and `announce` are recreated each render; the query and the open list decide a read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimmed, searches, opened, branch])

  const shown = found?.query === trimmed ? found.result : null
  const people = useMemo(
    () => (shown?.people ?? []).filter((p) => !staged.has(entryKey({ kind: 'user', id: p.id }))),
    [shown, staged],
  )
  const groups = useMemo(
    () => (shown?.groups ?? []).filter((g) => !staged.has(entryKey({ kind: 'group', id: g.id }))),
    [shown, staged],
  )

  const added = (addition: Addition) => {
    onAdd(addition)
    announce(`Added ${addition.name}`)
    setQuery('')
    setFieldError(undefined)
    combobox.closeDropdown()
  }

  const addByEmail = async (email: string) => {
    lookingUpRef.current = true
    setLookingUp(true)
    try {
      const result = await find(email)
      if (result.ok && result.data) {
        const person = result.data.people[0]
        if (person) added(personToAdd(person))
        else setFieldError(emailNotFoundMessage(addableByEmail))
        return
      }
      if (result.code === 'RATE_LIMITED') setFieldError(accessRefusalMessage(result.code))
      else if (!isLockout(result.code)) added({ kind: 'user', email, name: email })
    } catch (err: unknown) {
      console.error(err)
      added({ kind: 'user', email, name: email })
    } finally {
      lookingUpRef.current = false
      setLookingUp(false)
    }
  }

  const submit = (value: string) => {
    if (lookingUpRef.current) return
    const [kind, ...rest] = value.split(':')
    const id = rest.join(':')
    if (kind === 'email') {
      void addByEmail(id)
      return
    }
    const person = kind === 'user' ? people.find((p) => p.id === id) : undefined
    const group = kind === 'group' ? groups.find((g) => g.id === id) : undefined
    if (person) added(personToAdd(person))
    else if (group) added({ kind: 'group', id: group.id, name: group.name })
  }

  const groupOptions = groups.map((group) => (
    <Combobox.Option key={group.id} value={`group:${group.id}`}>
      <Group gap="xs" wrap="nowrap">
        <Avatar size={24} radius="xl" aria-hidden>
          <IconUsers size={14} />
        </Avatar>
        <div>
          <Text size="sm">{group.name}</Text>
          <Text size="xs">Group</Text>
        </div>
      </Group>
    </Combobox.Option>
  ))
  const personOptions = people.map((person) => (
    <Combobox.Option key={person.id} value={`user:${person.id}`}>
      <Group gap="xs" wrap="nowrap">
        <Avatar src={person.avatarUrl} alt="" size={24} radius="xl" aria-hidden>
          {person.name.charAt(0)}
        </Avatar>
        <div>
          <Text size="sm">{person.name}</Text>
          {(person.email ?? person.maskedEmail) && (
            <Text size="xs">{person.email ?? person.maskedEmail}</Text>
          )}
        </div>
      </Group>
    </Combobox.Option>
  ))

  const hint = (
    <Combobox.Empty>
      {searchable === 'nobody'
        ? 'Type their full email address.'
        : 'Type a name or a full email address.'}
    </Combobox.Empty>
  )
  let options: React.ReactNode = hint
  if (isEmail) {
    options = (
      <Combobox.Option value={`email:${trimmed}`}>
        <Group gap="xs" wrap="nowrap">
          <IconMail size={16} aria-hidden />
          <Text size="sm">Add {trimmed}</Text>
        </Group>
      </Combobox.Option>
    )
  } else if (trimmed === '') {
    if (people.length + groups.length > 0) {
      options = (
        <>
          {people.length > 0 && (
            <Combobox.Group label="Recently shared with">{personOptions}</Combobox.Group>
          )}
          {groups.length > 0 && <Combobox.Group label="Your groups">{groupOptions}</Combobox.Group>}
        </>
      )
    }
  } else if (searches) {
    options =
      people.length + groups.length > 0 ? (
        <>
          {personOptions}
          {groupOptions}
        </>
      ) : failedQuery === trimmed ? (
        <Combobox.Empty>{"Search isn't available right now. Try again."}</Combobox.Empty>
      ) : shown ? (
        <Combobox.Empty>{NO_NAME_MATCH}</Combobox.Empty>
      ) : (
        <Combobox.Empty>Searching…</Combobox.Empty>
      )
  }
  const optionsKey = `${trimmed}|${people.length}|${groups.length}`
  // Highlighted, so Enter right after typing picks the first option.
  useEffect(() => {
    if (opened) combobox.selectFirstOption()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, optionsKey])

  return (
    <Combobox store={combobox} onOptionSubmit={submit} withinPortal={false}>
      <Combobox.Target withExpandedAttribute>
        <TextInput
          ref={inputRef}
          label="Add people or groups"
          placeholder={searchable === 'nobody' ? 'Email address' : 'Name or email address'}
          value={query}
          error={fieldError}
          onChange={(event) => {
            setQuery(event.currentTarget.value)
            setFieldError(undefined)
            combobox.openDropdown()
            combobox.updateSelectedOptionIndex()
          }}
          onClick={() => combobox.openDropdown()}
          onBlur={() => combobox.closeDropdown()}
          rightSection={lookingUp ? <Loader size="xs" aria-label="Looking up…" /> : undefined}
          disabled={!!disabledReason}
          description={disabledReason}
          inputWrapperOrder={['label', 'input', 'description', 'error']}
          data-autofocus={!disabledReason || undefined}
          data-testid="share-people-input"
        />
      </Combobox.Target>
      <Combobox.Dropdown>
        <Combobox.Options mah={280} style={{ overflowY: 'auto' }}>
          {options}
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  )
}
