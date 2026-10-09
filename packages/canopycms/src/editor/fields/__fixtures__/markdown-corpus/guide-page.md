---
title: Getting started
description: Install the package and publish a first page.
tags:
  - guide
---

# Getting started

This guide walks through a first install. It covers _setup_, **configuration** and a first
publish, and links to the [reference](https://example.com/reference) where it helps.

## Install

Run the installer from the project root:

```bash
pnpm add example-package
```

Then add the config file:

```ts
export default defineConfig({
  contentRoot: 'content',
})
```

## Checklist

- Create the content folder
- Add a collection
  - Give it a name
  - Pick a schema
- Start the dev server

1. Open the editor.
2. Pick a branch.
3. Save, then publish.

> Saving writes the branch only. Publishing opens a pull request.

![Editor screenshot](/images/editor.png)

| Setting       | Default   | Notes                  |
| ------------- | --------- | ---------------------- |
| `contentRoot` | `content` | Relative to the root.  |
| `mode`        | `dev`     | Set `prod` on servers. |

---

Questions go to the [support page](/support).
