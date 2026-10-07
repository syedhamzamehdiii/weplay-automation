# WePlay Automation

Production automation management system for WePlay accounts, jobs, and Android workers. The same architecture is used from the first accounts through 300+.

Documentation:

- [Architecture](docs/architecture.md)
- [How it works](docs/working.md)
- [Setup instructions](docs/instructions.md)
- [Do not do](docs/donotdo.md)

Quick start:

```bash
cp .env.example .env
pnpm install
pnpm dev
```

Dashboard: http://localhost:5173 (see `.env` for the seeded admin password).
API: http://localhost:3001

Google Workspace user provisioning (own organization, Admin SDK Directory API) lives at **Google Workspace Users** in the dashboard. Configure domain and service-account credentials in `.env` only.
