#!/usr/bin/env bash
# Open the API on localhost:8090 for the Vite dev server running on this laptop.
exec ssh -N -L 8090:127.0.0.1:8090 "${SIH_HOST:-ubuntu@blankpoint.club}"
