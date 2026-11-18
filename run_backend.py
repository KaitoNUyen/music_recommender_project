"""Convenience runner for EmBeat Backend Server."""

import sys
from pathlib import Path
import uvicorn

# Ensure project root is in sys.path
PROJECT_ROOT = Path(__file__).resolve().parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

if __name__ == "__main__":
    print(f"Starting EmBeat FastAPI Server from {PROJECT_ROOT}...")
    uvicorn.run("backend.app:app", host="127.0.0.1", port=8000, reload=True)
