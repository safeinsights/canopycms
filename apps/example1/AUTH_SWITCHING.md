# Auth Provider Switching

This app supports switching between dev auth and Clerk auth without code changes.

## Default: Dev Auth

By default, the app uses **dev auth** (no real authentication required).

Just run:
```bash
npm run dev
```

Visit http://localhost:3000/edit and you'll see the dev user switcher.

## Switch to Clerk

Create `.env.local` (copy from `.env.local.clerk`):

```bash
CANOPY_AUTH_MODE=clerk
NEXT_PUBLIC_CANOPY_AUTH_MODE=clerk

NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=your_publishable_key
CLERK_SECRET_KEY=your_secret_key

CANOPY_BOOTSTRAP_ADMIN_IDS=user_xxxxxxxxxxxxx
```

Then restart the dev server.

## Switch Back to Dev

Remove `.env.local` or change the mode:

```bash
CANOPY_AUTH_MODE=dev
NEXT_PUBLIC_CANOPY_AUTH_MODE=dev
CANOPY_BOOTSTRAP_ADMIN_IDS=devuser_3xY6zW1qR5
```

## How It Works

The app checks `CANOPY_AUTH_MODE` environment variable:
- `dev` (default): Uses `createDevAuthPlugin()`
- `clerk`: Uses `createClerkAuthPlugin()`
- Invalid value: Throws error with allowed options

See:
- Server: `app/lib/canopy.ts`
- Client: `app/edit/page.tsx`
