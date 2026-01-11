# Integrations

Drop provider modules here.

Recommended pattern:
- providers/<provider>.js
- Each provider exports functions that call external APIs via:
  - /api/integrations/proxy (server-side allowlisted proxy), OR
  - Direct calls from the server (route handlers), OR
  - A background worker you control.

Security note:
- Prefer server-side calls.
- If using proxy, set INTEGRATION_PROXY_ALLOWLIST in .env.