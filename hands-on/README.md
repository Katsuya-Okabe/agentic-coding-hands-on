# hands-on 素材

研修で使うプロンプトと設定ファイルです。各 Day のドキュメントの指示に従って、コピーして使ってください。
書籍（[AgenticCoding.pdf](../docs/ref/AgenticCoding.pdf)）の付録をもとに、Claude Code と GitHub Codespaces 向けに書き換えています。

## Day1：Vibe Coding 体験

*   [vibe-chat.prompt.txt](day1/vibe-chat.prompt.txt)：Vibe Chat の作成依頼（書籍 PART3）

## Day2：Vibe Coding の限界と転換

*   [change-request.prompt.txt](day2/change-request.prompt.txt)：Vibe Chat への追加・仕様変更依頼
*   [inspection-commands.md](day2/inspection-commands.md)：品質検証コマンド集
*   [templates/.claude/settings.json](day2/templates/.claude/settings.json)：ガードレール（権限設定）

## Day3：開発基盤構築と要件の具体化

*   [templates/CLAUDE.md](day3/templates/CLAUDE.md)：プロジェクトルール（書籍の `.clinerules` 相当）
*   [templates/.claude/commands/selfcheck.md](day3/templates/.claude/commands/selfcheck.md)：`/selfcheck` コマンド
*   [templates/.claude/commands/save-plan.md](day3/templates/.claude/commands/save-plan.md)：`/save-plan` コマンド
*   [prompts/monorepo-bootstrap.prompt.txt](day3/prompts/monorepo-bootstrap.prompt.txt)：モノレポ雛形の構築計画
*   [prompts/vibe-order-requirements.md](day3/prompts/vibe-order-requirements.md)：Vibe Order 要求仕様（Codespaces 版）
*   [prompts/system-design-from-requirements.prompt.txt](day3/prompts/system-design-from-requirements.prompt.txt)：要件から設計書を作成
*   [prompts/split-design.prompt.txt](day3/prompts/split-design.prompt.txt)：設計書のパッケージ単位への分割

## Day4：Agentic Coding で実装

*   [commands/download-llms.sh](day4/commands/download-llms.sh)：Hono / Vite の `llms.txt` を取得
*   [prompts/shared-implementation-plan.prompt.txt](day4/prompts/shared-implementation-plan.prompt.txt)
*   [prompts/backend-implementation-plan.prompt.txt](day4/prompts/backend-implementation-plan.prompt.txt)
*   [prompts/frontend-implementation-plan.prompt.txt](day4/prompts/frontend-implementation-plan.prompt.txt)
*   [prompts/resume.template.prompt.txt](day4/prompts/resume.template.prompt.txt)：セッションを再開するときのテンプレート

## Day5：仕上げ、Before/After 比較、発表

*   [prompts/e2e-planning.prompt.txt](day5/prompts/e2e-planning.prompt.txt)：E2E テストの計画
*   [prompts/e2e-debug.prompt.txt](day5/prompts/e2e-debug.prompt.txt)：E2E 失敗時のデバッグ
*   [prompts/change-request-agentic.prompt.txt](day5/prompts/change-request-agentic.prompt.txt)：Vibe Order への変更依頼（Before/After 比較用）
*   [templates/vibe-order-ci-e2e.yml](day5/templates/vibe-order-ci-e2e.yml)：CI ワークフローの参考例
