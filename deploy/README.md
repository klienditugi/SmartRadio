# Docker Compose notes
#
# Run from the local clone directory named subwave-ai.
# Required host paths (set in `.env` next to that clone, not in this file):
#   SUBWAVE_DATA_DIR=/absolute/host/data
#   SUBWAVE_LIBRARY_DIR=/absolute/host/music
#   SUBWAVE_SECRETS_DIR=/absolute/host/secrets
#   SUBWAVE_CONFIG_DIR=/absolute/host/config   # contains subwave.yaml
#
# Live Oracle examples (operator config only, never compose defaults):
#   SUBWAVE_DOWNLOADS_DIR=/music/downloads   # acquisition landing/staging
#   SUBWAVE_LIBRARY_DIR=/music/library       # final library; Navidrome scanner is passive
#
# Music must never live only in the container writable layer.
# Ollama is not started here. Acquisition is optional until a verified daemon exists.
