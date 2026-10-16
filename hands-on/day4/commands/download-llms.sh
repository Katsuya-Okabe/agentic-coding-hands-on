#!/usr/bin/env bash
# Hono と Vite の公式ドキュメント（LLM 向け）を取得する。
# Claude Code の権限設定で curl を禁止しているため、このスクリプトは自分でターミナルから実行する。
set -euo pipefail

mkdir -p vibe-order/docs/ref/hono vibe-order/docs/ref/vite
curl -fsSL -o vibe-order/docs/ref/hono/llms.txt https://hono.dev/llms.txt
curl -fsSL -o vibe-order/docs/ref/vite/llms.txt https://vite.dev/llms.txt
ls -l vibe-order/docs/ref/hono vibe-order/docs/ref/vite
