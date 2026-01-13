# Audit Logging for Permissions and Groups

## Overview

Add comprehensive audit logging for permission and group changes beyond git history. While git provides version control, we need structured audit trails for compliance, notifications, and easier querying.

## Current State

**What we have:**

- `updatedAt` and `updatedBy` fields in permissions.json and groups.json
- Git history provides commit-level tracking
- PR creation for settings changes in prod mode

**Limitations:**

- No structured audit log queryable without git access
- No change notifications/webhooks
- PR descriptions are generic (don't include detailed diffs)
- No compliance-friendly audit reports

## Proposed Features

### 1. Structured Audit Trail

**Storage Options:**

- File-based: `.canopycms/audit-log.jsonl` (append-only newline-delimited JSON)
- Database: For production systems with proper DB
- External: Send to external audit service (e.g., CloudWatch, Splunk)

**Event Schema:**

```typescript
interface AuditEvent {
  id: string // UUID
  timestamp: string // ISO8601
  eventType:
    | 'permissions.updated'
    | 'groups.updated'
    | 'groups.member.added'
    | 'groups.member.removed'
  actor: {
    userId: CanopyUserId
    groups: CanopyGroupId[]
  }
  target: {
    type: 'permissions' | 'groups'
    contentVersion: number // Version after change
  }
  changes: {
    before: any // Previous state
    after: any // New state
    diff: string // Human-readable diff
  }
  metadata: {
    mode: BranchMode
    branchName: string
    ipAddress?: string
    userAgent?: string
  }
}
```

### 2. Query API

Add endpoints to query audit history:

```typescript
// GET /api/audit?eventType=permissions.updated&from=2024-01-01&to=2024-12-31
interface AuditQuery {
  eventType?: string
  userId?: string
  from?: string // ISO8601
  to?: string // ISO8601
  limit?: number
  offset?: number
}
```

### 3. Change Notifications

**Webhooks:**

- Configure webhook URLs for permission/group changes
- POST audit events to external systems
- Retry logic for failed deliveries

**In-App Notifications:**

- Notify admins when permissions change
- Show "who changed what when" in UI

### 4. Enhanced PR Descriptions

When creating settings PRs, include:

```markdown
## Permission Changes by user-123 at 2024-01-12T15:30:00Z

### Added Rules

- `content/posts/**` - Allowed groups: [Editors] for read,edit

### Modified Rules

- `content/drafts/**` - Added user-456 to allowed users

### Removed Rules

- `content/admin/**` - (removed entire rule)

### Group Changes

- **Editors**: Added user-789, removed user-012
- **Reviewers**: No changes

⚠️ **Note**: Changes are already active in the CMS. This PR provides review and persistence when merged.
```

### 5. Compliance Reports

Generate reports for compliance audits:

- "All permission changes in Q4 2024"
- "Who had access to path X on date Y"
- "Changes made by user Z"
- Export as CSV/PDF for audit submissions

## Implementation Plan

### Phase 1: Basic Audit Trail (File-Based)

1. Create `AuditLogger` class with append-only JSONL writer
2. Integrate into `savePathPermissions` and `saveInternalGroups`
3. Record before/after state on every change
4. Add simple diff generation (JSON diff)

### Phase 2: Query Interface

1. Add `loadAuditEvents(query)` function to read JSONL
2. Create `/api/audit` endpoint with filtering
3. Add UI to view audit history (admin-only)

### Phase 3: Enhanced PR Descriptions

1. Generate structured diff in `commitToSettingsBranch`
2. Include in PR body template
3. Add links to specific changed rules

### Phase 4: Webhooks & Notifications

1. Add webhook configuration to CanopyConfig
2. Implement delivery queue with retries
3. Add in-app notification system

### Phase 5: Compliance Features

1. Build report generation utilities
2. Add export formats (CSV, PDF)
3. Create admin dashboard for audit overview

## Configuration

```typescript
// canopycms.config.ts
export default defineCanopyConfig({
  audit: {
    enabled: true,
    storage: 'file', // or 'database', 'external'
    filePath: '.canopycms/audit-log.jsonl', // For file storage
    retention: 365, // Days to keep audit logs
    webhooks: [
      {
        url: 'https://audit-service.example.com/webhook',
        events: ['permissions.updated', 'groups.updated'],
        secret: process.env.AUDIT_WEBHOOK_SECRET,
      },
    ],
  },
})
```

## Security Considerations

1. **Audit Log Integrity**: Consider signing audit events (HMAC) to prevent tampering
2. **Access Control**: Only admins should query audit logs
3. **PII Handling**: User IDs in audit logs - consider GDPR implications
4. **Retention**: Automatically purge old audit events per retention policy
5. **Webhooks**: Use secrets to authenticate webhook deliveries

## Related Files

- `permissions-loader.ts` - Add audit logging in save functions
- `groups-loader.ts` - Add audit logging in save functions
- `services.ts` - Integrate audit logger into service layer
- New: `audit-logger.ts` - Core audit logging implementation
- New: `api/audit.ts` - Query API endpoint

## Priority

**Medium** - Not blocking current work, but valuable for production deployments with compliance requirements.

## Estimated Effort

- Phase 1 (Basic): 2-3 days
- Phase 2 (Query): 1-2 days
- Phase 3 (PR diffs): 1 day
- Phase 4 (Webhooks): 2-3 days
- Phase 5 (Reports): 3-4 days

**Total**: ~2 weeks for full implementation
