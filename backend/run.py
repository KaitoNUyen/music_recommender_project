"""Runner for EmBeat Backend Server when executing inside backend directory."""

import sys
from pathlib import Path
import uvicorn

# Add parent (project root) to sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

if __name__ == "__main__":
    print(f"Starting EmBeat FastAPI Server from {PROJECT_ROOT}...")
    uvicorn.run("backend.app:app", host="127.0.0.1", port=8000, reload=True)
