# Docker Compose notes
#
# Required host paths (set in `.env` next to the clone, not in this file):
#   SUBWAVE_DATA_DIR=/absolute/host/data
#   SUBWAVE_LIBRARY_DIR=/absolute/host/music
#   SUBWAVE_SECRETS_DIR=/absolute/host/secrets
#   SUBWAVE_CONFIG_DIR=/absolute/host/config   # contains subwave.yaml
#
# Music must never live only in the container writable layer.
# Ollama is not started here.
