set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

default:
    @just --list

sync:
    uv sync --frozen

doctor:
    uv run --frozen scripts/doctor.py

quick-validate *args:
    uv run --frozen scripts/quick_validate.py {{args}}

bridge-regression *args:
    uv run --frozen scripts/bridge_regression.py {{args}}

preview file root port='8777' *args:
    uv run --frozen scripts/preview.py --file "{{file}}" --root "{{root}}" --port "{{port}}" {{args}}

open-visible url='http://127.0.0.1:8777/' session='md-preview-visible' *args:
    uv run --frozen scripts/open_visible.py --url "{{url}}" --session "{{session}}" {{args}}
