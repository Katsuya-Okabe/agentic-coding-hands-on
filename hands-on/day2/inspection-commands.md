# Vibe Chat 品質検証コマンド

Day2 の「品質を検証する」で使うコマンドです。**AI に頼らず、自分でターミナルから実行**してください。
結果は [Vibe vs Agentic 比較シート](../../docs/worksheets/VibeVsAgentic比較シート.md) の「Vibe Chat」列に記入します。

> [!NOTE]
> Vibe Chat の構成は人によって異なります。`package.json` が複数ある場合は、それぞれのディレクトリで実行してください。
> `package.json` の場所は `find vibe-chat -name package.json -not -path "*/node_modules/*"` で確認できます。

## 1. テストはあるか

```bash
cd vibe-chat
npm run test
```

*   `Missing script: "test"` や `no test specified` と表示されたら、テストはありません。
*   テストファイルの数を数えます。

```bash
find . -path ./node_modules -prune -o \( -name "*.test.*" -o -name "*.spec.*" \) -print | wc -l
```

## 2. Lint と Format は設定されているか

```bash
npm run lint
npx @biomejs/biome lint .
```

*   `lint` スクリプトがない場合は、Biome で一時的にチェックしてエラー件数を記録します。

## 3. 依存パッケージに脆弱性はないか

```bash
npm audit
```

*   `found N vulnerabilities` の件数と重大度（critical / high / moderate / low）を記録します。

## 4. 古いライブラリを使っていないか

```bash
npm outdated
```

*   `Current` と `Latest` のメジャーバージョンが違うパッケージの数を数えます。

## 5. 依存パッケージはいくつあるか、説明されているか

```bash
npm ls --depth=0
```

*   AI が追加理由を説明しなかったパッケージがいくつあるか、数えてみましょう。

## 6. 秘密情報が書かれていないか

```bash
grep -rnE "(secret|password|api[_-]?key|token)\s*[:=]" --include=*.ts --include=*.tsx --include=*.js --include=*.json . | grep -v node_modules
```

## 7. 既存機能は壊れていないか（手動確認）

機能追加の前に動いていた機能を、ブラウザで確認します。

*   [ ] ダイレクトメッセージを送れる
*   [ ] グループチャットを送れる
*   [ ] スレッドに返信できる
*   [ ] オンラインステータスが表示される
*   [ ] ファイルを共有できる
*   [ ] 共同編集ドキュメントを開ける
