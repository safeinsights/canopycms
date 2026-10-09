/**
 * Preview field marks, typed against the view's content. Exported from the root `canopycms`,
 * not `canopycms/preview`: that module is `'use client'`, and a server component calling its
 * functions gets a client reference that throws. A public page passes `fieldProps` as
 * `undefined`, never a no-op function, which Next refuses to pass from server to client.
 */

import type { ResolvedReferenceMeta } from '../entry-schema'
import { normalizeCanopyPath, type CanopyPathSegment } from './canopy-path'

export type FieldAttrs = { 'data-canopy-path'?: string }

type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'
type IsDigits<S extends string> = S extends `${Digit}${infer Rest}`
  ? Rest extends ''
    ? true
    : IsDigits<Rest>
  : false
type ParseSegment<S extends string> = IsDigits<S> extends true ? number : S
type ParseBrackets<S extends string> = S extends `${infer Key}[${infer Index}]${infer Rest}`
  ? [...(Key extends '' ? [] : [ParseSegment<Key>]), ParseSegment<Index>, ...ParseBrackets<Rest>]
  : S extends ''
    ? []
    : [ParseSegment<S>]
/** As `parseCanopyPath`: `'blocks.0.title'` → `['blocks', number, 'title']`. */
type ParsePath<S extends string> = S extends `${infer Head}.${infer Rest}`
  ? [...ParseBrackets<Head>, ...ParsePath<Rest>]
  : ParseBrackets<S>

type ImageKeys = 'src' | 'alt' | 'width' | 'height' | 'crop'
/** A value the form edits as one field: a scalar, a reference in any state, an image. */
type IsLeaf<V> = V extends string | number | boolean | bigint | symbol
  ? true
  : V extends { unavailable: true } | ResolvedReferenceMeta
    ? true
    : V extends { src: string; alt: string }
      ? [Exclude<keyof V, ImageKeys>] extends [never]
        ? true
        : false
      : false

/** A block item's fields are its template's, under `value`; the form's paths skip `value`. */
type ListItem<E> = E extends { template: string; value: infer W }
  ? [Exclude<keyof E, 'template' | 'value'>] extends [never]
    ? W
    : E
  : E

type NextSegment<V> = unknown extends V
  ? CanopyPathSegment
  : V extends unknown
    ? IsLeaf<V> extends true
      ? never
      : V extends readonly unknown[]
        ? number
        : V extends object
          ? keyof V & string
          : never
    : never

type Child<V, S> = unknown extends V
  ? unknown
  : V extends unknown
    ? V extends readonly (infer E)[]
      ? S extends number
        ? NonNullable<ListItem<NonNullable<E>>>
        : never
      : IsLeaf<V> extends true
        ? never
        : S extends keyof V
          ? NonNullable<V[S]>
          : never
    : never

type ValueAt<V, P> = P extends readonly [infer Head, ...infer Rest]
  ? ValueAt<Child<V, Head>, Rest>
  : V

type IsFieldPath<V, P> = P extends readonly [infer Head, ...infer Rest]
  ? Head extends NextSegment<V>
    ? IsFieldPath<Child<V, Head>, Rest>
    : false
  : true

/** The path with the allowed segments at its first wrong one, for the compile error. */
type ExpectedSegments<V, P> = P extends readonly [infer Head, ...infer Rest]
  ? Head extends NextSegment<V>
    ? readonly [Head, ...ExpectedSegments<Child<V, Head>, Rest>]
    : readonly [NextSegment<V>, ...CanopyPathSegment[]]
  : readonly []

type SegmentsArg<V, P> = unknown extends V
  ? P
  : IsFieldPath<V, P> extends true
    ? P
    : ExpectedSegments<V, P>

type Spell<P> = P extends readonly [infer Head, ...infer Rest]
  ? `${Head extends number ? `[${Head}]` : `.${Head & string}`}${Spell<Rest>}`
  : ''
type TrimDot<S extends string> = S extends `.${infer Rest}` ? Rest : S
/** The paths one step past `P`'s last valid prefix, for the compile error. */
type Completions<V, P, Done extends readonly CanopyPathSegment[] = []> = P extends readonly [
  infer Head,
  ...infer Rest,
]
  ? Head extends NextSegment<V>
    ? Completions<Child<V, Head>, Rest, [...Done, Head]>
    : [NextSegment<V>] extends [never]
      ? TrimDot<Spell<Done>>
      : TrimDot<Spell<[...Done, NextSegment<V>]>>
  : never

type ComputedPathError =
  'a computed string path is untyped: pass segments, e.g. ["list", i, "field"]'

type StringArg<V, S extends string> = unknown extends V
  ? S
  : string extends S
    ? ComputedPathError
    : IsFieldPath<V, ParsePath<S>> extends true
      ? S
      : Completions<V, ParsePath<S>>

/** `NonNullable<unknown>` is `{}`, which would make untyped content typed. */
type Content<T> = unknown extends T ? unknown : NonNullable<T>

declare const fieldPropsContent: unique symbol

/**
 * Marks the element rendering a field: `<h1 {...fieldProps('title')}>`. A path is a string
 * literal or segments (`['blocks', i, 'title']`, for anything computed), checked against `T`
 * the way the form names fields: a block's fields follow its index (no `.value`), and nothing
 * is below a reference or image. Any template's fields compile after a block's index; the
 * editor warns about the rest. `FieldProps` alone (`T = unknown`) takes any path.
 */
export type FieldProps<T = unknown> = FieldPropsCall<Content<T>> & {
  /** Bivariant, so a block scope's `FieldProps<Union>` fits one template's component. */
  readonly [fieldPropsContent]?: { bivariant(content: T): void }['bivariant']
}

interface FieldPropsCall<V> {
  <const S extends string>(path: StringArg<V, S>): FieldAttrs
  <const P extends readonly CanopyPathSegment[]>(path: SegmentsArg<V, P>): FieldAttrs
}

type UntypedFieldProps = (path: string | readonly CanopyPathSegment[]) => FieldAttrs

const markField: UntypedFieldProps = (path) => {
  const normalized = normalizeCanopyPath(path)
  return normalized ? { 'data-canopy-path': normalized } : {}
}

/**
 * An empty path marks nothing, so a component's root mark (`[]`) emits no attribute unscoped.
 * @internal `useCanopyPreview` is its only caller.
 */
export const createFieldProps = <T>(): FieldProps<T> => markField

/** `fieldProps(path)`, or nothing on a public page; `[]` marks the field a caller scoped to. */
export function fieldAttrs<T, const S extends string>(
  fieldProps: FieldProps<T> | undefined,
  path: StringArg<Content<T>, S>,
): FieldAttrs
export function fieldAttrs<T, const P extends readonly CanopyPathSegment[]>(
  fieldProps: FieldProps<T> | undefined,
  path: SegmentsArg<Content<T>, P>,
): FieldAttrs
export function fieldAttrs(
  fieldProps: UntypedFieldProps | undefined,
  path: string | readonly CanopyPathSegment[],
): FieldAttrs {
  return fieldProps ? fieldProps(path) : {}
}

/**
 * `fieldProps` for a component rendering part of the entry, which marks paths relative to it
 * while its caller names the part: `scopeFieldProps(fieldProps, ['sections', i])`. `undefined`
 * in, `undefined` out, so a public page never builds a function.
 */
export function scopeFieldProps<T, const S extends string>(
  fieldProps: FieldProps<T> | undefined,
  prefix: StringArg<Content<T>, S>,
): FieldProps<ValueAt<Content<T>, ParsePath<S>>> | undefined
export function scopeFieldProps<T, const P extends readonly CanopyPathSegment[]>(
  fieldProps: FieldProps<T> | undefined,
  prefix: SegmentsArg<Content<T>, P>,
): FieldProps<ValueAt<Content<T>, P>> | undefined
export function scopeFieldProps(
  fieldProps: UntypedFieldProps | undefined,
  prefix: string | readonly CanopyPathSegment[],
): UntypedFieldProps | undefined {
  if (!fieldProps) return undefined
  const base = normalizeCanopyPath(prefix)
  return (path) => {
    const relative = normalizeCanopyPath(path)
    if (!relative) return fieldProps(base)
    return fieldProps(relative.startsWith('[') ? `${base}${relative}` : `${base}.${relative}`)
  }
}
