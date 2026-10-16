# SPEC — minato

## 22. 港 (`minato`) — CLI×開発の道具
- **一行**: localhost で使われているポートを、どのプロジェクトのどの開発サーバーかで一覧し、空いているポートを提案する CLI。
- **核**: 量産するとポート番号が衝突する(実際に 5380・5410・5730 が重複している)。各リポジトリの vite.config や package.json からポートの台帳を作り、重複を警告する。
- **技術**: Node(依存ゼロ) / lsof とファイル走査 / 台帳と衝突検出は純粋関数
- **公開**: LP(GitHub Pages)+ GitHub
- **難所**: lsof の出力の差異。設定ファイルに書かれていないポートの扱い。

---

# 共通ルール(アプリ20本量産フェーズ)

- **規模**: 1〜2日で「公開まで」行ける範囲に絞る。上の仕様で一点突破し、機能を足さない。
- **作風**: 一点突破のコンセプト / ブラウザ内で完結(サーバ不要) / カメラ・センサー・数理を使った遊び心 / 「正直さ」を設計で守る(測れないときは測れないと言う、根拠と誤差を見せる) / 純粋ロジック+テスト。
- **構成(Webアプリ)**: Vite + 素のJS + pnpm。中核ロジックは `src/lib/` の純粋関数にして Vitest で固くテストし、配線・描画と分ける。`window.__app` を公開して、ヘッドレスでも検証できるようにする。
- **カメラ/マイク/センサー**: 実機がなくても検証できるよう、合成データやデモ入力で動くモードを用意する。
- **ポート**: 下に指定した番号を `strictPort` で固定する(既存アプリとの衝突回避)。
- **参考になる既存作**: `~/ranzo_project/` 配下(例: takibiban, otomon, uchikeshi, sokomi, shikisougi)。品質の基準はこれらに合わせる。
- **公開**: GitHub(public) `Jinshin2534/<slug>` を gh で作成して push。Webアプリは Vercel に GitHub 連携でデプロイする(push で自動デプロイ)。Vercel 向きでないもの(CLI等)は簡素なLPを GitHub Pages で公開する。
- **完了時**: 公開URLを確かめたうえで、メモリ `/Users/nokokoro/.claude/projects/-Users-nokokoro-ranzo-project/memory/` に `<slug>.md` を追加し、`MEMORY.md` に既存の行と同じ形式で1行追記する(公開URL・port・テスト数・ハマりどころ)。
- **コミット**: 末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` をつける。
- **仕様は確定済み**。細部は自分で判断して進め、ユーザーに聞くのは本当に決められないときだけにする。
- **このアプリのポート**: なし(CLI。LPのローカル確認が要るなら 5980)
- **slug**: `minato`
- **構成の例外**: Webアプリではなく Node のCLI(依存ゼロ)。台帳作りと衝突検出は純粋関数でVitest。走査の対象は ~/ranzo_project と ~/orca/workspaces。公開は GitHub(public)+GitHub PagesのLP。参考は ~/ranzo_project/yoban。

# リポジトリ構成と公開手順

- このワークツリーは `app-ideas` リポジトリのブランチ `minato`。アプリはこのワークツリー直下に作る。
- main から引き継いだ `README.md` はこのアプリ用に書き換え、`IDEAS.md` は削除してよい(main 側には影響しない)。
- 公開用の GitHub リポジトリはアプリごとに別に作る:
  1. `gh repo create Jinshin2534/minato --public`
  2. `git remote add minato https://github.com/Jinshin2534/minato.git`
  3. `git push minato HEAD:main`(以後の更新も `git push minato HEAD:main`)
- `app-ideas` 自体には push しない。リモート名はアプリの slug にして、ほかのアプリのリモートと混ぜない。
- Vercel は GitHub の `Jinshin2534/minato` を連携し、main への push で自動デプロイされるようにする。
