# GitHub Repo Description

## Short description

Swipe-review your Immich library, train a CLIP + Qdrant model from manual decisions, and auto-archive bad photos with a user-controlled threshold.

## Medium description

Immich Swipe is a Vue + Node app for reviewing Immich photos Tinder-style. Manual keep/archive decisions train CLIP embeddings in Qdrant, a triage view scores batches of images, and an optional cron job auto-archives high-confidence bad photos without feeding those automated decisions back into training.

## Key highlights

- Manual swipe review for Immich
- CLIP embeddings + Qdrant vector search
- Batch triage view for extra training
- Toggleable cron auto-archive
- User-set certainty threshold in the web UI
- Manual training only; automation never retrains the model
- Docker image available at `goethenorris/swiparr:v2`

## Suggested GitHub topics

- `immich`
- `photo-management`
- `vue`
- `typescript`
- `docker`
- `qdrant`
- `vector-search`
- `machine-learning`
- `self-hosted`

## Quick install snippet

```bash
cp env.example .env
docker compose -f docker-compose.published.yml up -d
```

Then open `http://localhost:8080`.

## Notes for users

- Manual review creates the training data.
- The auto-archive threshold is configurable in the web UI.
- Cron auto-archive requires `AUTO_ARCHIVE_IMMICH_URL` and `AUTO_ARCHIVE_API_KEY`.
- Settings persist when `/data` is bind-mounted or backed by a Docker volume.