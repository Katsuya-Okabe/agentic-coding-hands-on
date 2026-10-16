# Day3 開発基盤構築と要件の具体化

今日から Agentic Coding で「Vibe Order」を開発します。
いきなりコードを書かせるのではなく、まず **AI が品質を守りながら働ける土台**を作ります。そのうえで、要件を AI と一緒に具体化し、設計書にまとめます。

## 今日のゴール

*   CLAUDE.md とカスタムコマンドで、AI にプロジェクトのルールを伝えられる
*   Plan モードで計画を立てさせ、人がレビューしてから実行させる流れを体験する
*   テスト、Lint、CI が揃ったモノレポの雛形を作る
*   Vibe Order の要件から設計書を作り、パッケージ単位に分割する

## タイムテーブル

| 時間 | 内容 | 形式 |
| :--- | :--- | :--- |
| 9:30〜9:45 | 前日の振り返り | 全体 |
| 9:45〜10:05 | ミニ講義：ルール、コマンド、Plan モード | 講義 |
| 10:05〜10:45 | CLAUDE.md とカスタムコマンドを配置する | ハンズオン |
| 10:45〜12:00 | **Plan モードでモノレポの構築計画を立て、レビューする** | ハンズオン |
| 12:00〜13:00 | 昼休憩 | |
| 13:00〜14:30 | モノレポを構築する | ハンズオン |
| 14:30〜15:15 | CI を動かし、Pull Request でマージする | ハンズオン |
| 15:15〜17:00 | **要件から設計書を作る** | ハンズオン |
| 17:00〜17:30 | 日報 | 個人 |

## 書籍の該当箇所

*   PART5 Agentic Coding - 開発基盤構築
    *   Rules、Workflows、ignore 設定
    *   npm workspaces によるモノレポ構築
    *   テスト、Lint、Husky、Gitleaks、GitHub Actions
*   PART6 Agentic Coding - コーディング（前半：要件から設計書へ）

## ミニ講義のポイント（20分）

書籍は Cline を使っていますが、本研修では Claude Code の同等機能に読み替えます。

| 書籍（Cline） | 本研修（Claude Code） | 役割 |
| :--- | :--- | :--- |
| `.clinerules/` | `CLAUDE.md` | AI が毎回読むプロジェクトのルール |
| Workflows | `.claude/commands/*.md` | よく使う指示を `/コマンド名` で呼び出す |
| `.clineignore`、Auto-approve | `.claude/settings.json` | 読ませないファイル、許可するコマンド |
| Plan / Act、`/deep-planning` | Plan モード | 実行前に計画を立てさせる |

*   **ルールは短く、仕組みで強制する**：CLAUDE.md に「テストを通すこと」と書くだけでなく、Husky と CI で通らないとコミットやマージができないようにします。
*   **Plan → レビュー → 実行**：AI の計画を読んで、納得してから実行させます。計画の段階で直すほうが、コードを直すよりずっと安上がりです。

## ハンズオン

### 1. CLAUDE.md とカスタムコマンドを配置する

```bash
cp hands-on/day3/templates/CLAUDE.md CLAUDE.md
mkdir -p .claude/commands && cp hands-on/day3/templates/.claude/commands/*.md .claude/commands/
```

1.  [CLAUDE.md](../hands-on/day3/templates/CLAUDE.md) を読み、各ルールが Day2 で見つけたどの問題を防ぐためのものかを考えます。
2.  自分のチームで話し合ったルールを、CLAUDE.md に **1つ以上追加** します（例：「コメントは日本語で書く」）。
3.  [selfcheck.md](../hands-on/day3/templates/.claude/commands/selfcheck.md) と [save-plan.md](../hands-on/day3/templates/.claude/commands/save-plan.md) を読みます。
4.  チャットパネルで新しい会話を始め、`/` を入力して `selfcheck` と `save-plan` が候補に出ることを確認します。

### 2. Plan モードでモノレポの構築計画を立てる

1.  チャットパネルを **Plan モード**に切り替えます。
2.  [monorepo-bootstrap.prompt.txt](../hands-on/day3/prompts/monorepo-bootstrap.prompt.txt) を貼り付けて送信します。
3.  出てきた計画を**レビュー**します。次の観点で確認し、気になる点は修正を依頼します。
    *   [ ] 各イテレーションに「確認するコマンド」があるか
    *   [ ] 追加されるライブラリの理由が説明されているか、ライセンスは MIT / Apache-2.0 / BSD か
    *   [ ] 不要なものが入っていないか（KISS）
4.  納得したら `/save-plan monorepo` で計画を保存し、ADR と Design Doc ができていることを確認します。

### 3. モノレポを構築する

1.  計画を承認して実行させます。編集は自動承認（**Edit automatically**）にしてかまいません。コマンドは `settings.json` の設定に従って確認されます。
2.  イテレーションが終わるごとに、自分でもターミナルで確認します。

    ```bash
    cd vibe-order
    npm run check
    npm run test
    npm run build
    ```

3.  すべて成功したら `/selfcheck @vibe-order/docs/plans モノレポ雛形` を実行し、未完了がないかを確認させます。

> [!NOTE]
> Playwright のブラウザが入っていないとエラーになる場合は、ターミナルで `npx playwright install --with-deps chromium` を実行してください。

### 4. CI を動かし、Pull Request でマージする

1.  作業ブランチを作ってコミットし、push します。

    ```bash
    git switch -c feature/monorepo
    git add -A && git commit -m "Day3: monorepo scaffold"
    git push -u origin feature/monorepo
    ```

2.  GitHub で Pull Request を作り、**Actions** タブで CI が実行されて成功することを確認します。
3.  わざと Lint エラーを1つ入れて push し、**CI が失敗する**ことを確認してから元に戻します。
4.  ブランチ保護ルールに「CI の成功を必須にする（Require status checks）」を追加します。
5.  CI が成功したら `main` にマージし、Codespaces 側でも `git switch main && git pull` します。

### 5. 要件から設計書を作る

1.  要求仕様をプロジェクトにコピーします。

    ```bash
    mkdir -p vibe-order/docs && cp hands-on/day3/prompts/vibe-order-requirements.md vibe-order/docs/requirements.md
    ```

2.  Day2 で書いた「曖昧な点のメモ」をもとに、`requirements.md` に自分の決定を追記します（例：「即時 = 1秒以内」）。
3.  **Plan モード**で [system-design-from-requirements.prompt.txt](../hands-on/day3/prompts/system-design-from-requirements.prompt.txt) を送信します。
4.  AI からの質問に答えます。**ここが「要件の具体化」です。**答えた内容は `requirements.md` にも反映させます。
5.  計画を承認し、`vibe-order/docs/design/system-design.md` として保存させます。
6.  設計書をレビューします。
    *   [ ] MVP の機能がすべて含まれているか
    *   [ ] 各機能に、テストで確認できる受け入れ条件があるか
    *   [ ] 注文の状態遷移（受付 → 調理中 → 提供済、キャンセルは受付のみ）が明記されているか
7.  [split-design.prompt.txt](../hands-on/day3/prompts/split-design.prompt.txt) で、設計書をパッケージ単位に分割させます。
8.  ブランチを作り、Pull Request でマージします。

## チェックポイント

*   [ ] `CLAUDE.md` と `.claude/commands/` を配置し、ルールを1つ以上追加した
*   [ ] `vibe-order/` で `npm run check`、`npm run test`、`npm run build` が成功する
*   [ ] Pull Request で CI が成功し、`main` にマージした
*   [ ] CI 必須のブランチ保護を設定した
*   [ ] `system-design.md` と各パッケージの `design.md` ができた

## 振り返り（日報）

*   Plan モードの計画をレビューして、自分で直させたところはどこですか
*   AI からの質問で、自分が考えていなかった点はありましたか
