---
description: 合意した実装計画を保存し、ADR と Design Doc を更新する
argument-hint: <計画の名前（例: vibe_order）>
---

直前に合意した実装計画を、以下の手順でドキュメントとして保存してください。計画名: $ARGUMENTS

1. 実装計画の全文を `vibe-order/docs/plans/plan_<計画名>_yyyyMMddHHmmss.md` に保存する。
2. 計画の内容から Architecture Decision Record (ADR) を作成し、`vibe-order/docs/adr/` に保存する。
   - 形式は Michael Nygard の ADR に準拠（Title / Status / Context / Decision / Consequences）
3. 計画の内容から Design Doc を作成し、`vibe-order/docs/design/` に保存・更新する。
   - 形式は Google Design Docs に準拠（Context and Scope / Goals and Non-Goals / Design / Alternatives Considered）
4. 実装後に計画と実装に差分が出た場合は、保存した計画と Design Doc を最新化する。

保存したファイルの一覧を最後に報告してください。
