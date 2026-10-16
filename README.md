# 港 (minato)

**LP: https://jinshin2534.github.io/minato/** ・ **GitHub: https://github.com/Jinshin2534/minato**

localhost で使われているポートを、**どのプロジェクトのどの開発サーバーか**で一覧し、
重複を警告して、空いているポートを提案する CLI。依存ゼロ(Node だけ)。

アプリを量産していると、ポート番号がいつのまにか重なる。
`vite.config.js` や `package.json` に書いたポートを全リポジトリから集めて台帳にし、
同じ番号を別のアプリが宣言していたら知らせる。いま待ち受けているプロセスは `lsof` で突き合わせる。

```
$ minato conflicts
⚠ 衝突 5 件 — 同じポートを別のアプリが宣言している
  5380
    - maai               ~/ranzo_project/maai/vite.config.js:4
    - sora-shirabe       ~/ranzo_project/sora-shirabe/package.json:7
  5410
    - kemuri-ate         ~/ranzo_project/kemuri-ate/vite.config.js:4  strictPort なし→黙ってずれる
    - kemuri-so          ~/ranzo_project/kemuri-so/vite.config.js:4  strictPort なし→黙ってずれる
  5730
    - denpa-scope        ~/ranzo_project/denpa-scope/server.js:12  既定値
    - sokomi             ~/ranzo_project/sokomi/vite.config.js:4
```

## つかう

```bash
git clone https://github.com/Jinshin2534/minato && cd minato
npm link            # または: node bin/minato.js
```

```bash
minato                    # 台帳 + 稼働状況 + 衝突 + 空き候補
minato conflicts          # 衝突だけ(あれば終了コード 1)
minato suggest            # 空いているポートを3つ(実際に bind して確かめる)
minato suggest --next     # いちばん大きい番号の次の区切り(新しいアプリに払い出す用)
minato who 5173           # そのポートを宣言しているアプリと、いま使っているプロセス(minato 5173 でも同じ)
minato live [--all]       # いま待ち受けているポート
```

| オプション | 意味 |
|---|---|
| `--roots a:b` | 走査するフォルダ。既定は `~/ranzo_project:~/orca/workspaces`。環境変数 `MINATO_ROOTS` でも可 |
| `--range 5000-5999` `--step 10` `--near 5400` `-n 3` | 提案の範囲・刻み・近さ・数 |
| `--all` | 隠しているもの(Vite 既定に任せたアプリの内訳、10000 以上の番号、プロジェクト外のプロセス)も出す |
| `--json` | 機械向け JSON |
| `--no-live` / `--no-probe` | lsof を呼ばない / 提案時に bind で確かめない |

終了コード: `0` 問題なし / `1` 衝突あり(`list` と `conflicts`)/ `2` 引数の誤り / `3` 測れない(走査対象なし・lsof なし)

## 何を「宣言」として拾うか

| 場所 | 例 | 確度 |
|---|---|---|
| `vite.config.*` | `server: { port: 5410 }`、`preview: { port: … }`、`strictPort` | 宣言 |
| `package.json` の scripts | `vite --port 5380 --strictPort`、`-p 3020`、`PORT=3030 node …` | 宣言 |
| `.env` / `.env.*` | `PORT=3000`、`API_PORT=8080`(`.env.example` は読まない) | 宣言 |
| コード(直下・`bin/`・`server/`・`src/config.*` など) | `process.env.YOBAN_PORT ?? 5460` | 既定値 |
| 同上 | `.listen(4000)`、`const PORT = 4000` | 推定 |
| どこにも書いていない Vite アプリ | — | 暗黙(5173 / 4173) |

- **同じアプリの別ワークツリーは衝突にしない**。「同じ git リポジトリ(共通ディレクトリ)」かつ「同じ package 名」なら同じアプリ。
  1つのリポジトリにブランチ別の別アプリが同居している場合(app-ideas のワークツリー群)は、名前が違うので別アプリとして数える
- **暗黙(ポート未指定で Vite の既定に任せている)は衝突に数えず、別枠で警告する**。数えると数十件の「衝突」で本物が埋もれるため。
  ただし同時に起動すると後から起動したほうが黙って 5174 にずれる、とは書いて出す
- 推定(コードからの読み取り)が絡む衝突は「推定を含む」と添える

## 正直さのための作り

- **測れないときは測れないと言う**。`lsof` が無い・走査対象が見つからない場合、空の結果で「衝突なし」「全部空き」とは言わずに終了コード 3 で止まる
- `lsof` は**自分のユーザーのプロセスしか見えない**ことがある。そこで `suggest` は候補を実際に `127.0.0.1` と `::` で bind して確かめ、
  bind できなかった番号は理由つきで外す
- 提案では、台帳の番号に加えて、`strictPort` なしの宣言の +1〜+2(Vite が衝突時にずれていく先)、
  5000 / 7000(macOS の AirPlay 受信)、5173 / 4173(Vite の既定)を避ける
- **台帳外で稼働中**: プロジェクトの中で動いているのに設定にそのポートが書かれていないプロセスを出す。
  ただし 10000 以上の番号は補助プロセスが OS に任せて取った番号とみて警告しない(件数だけ言う。`--all` で全部)

## テスト

```bash
pnpm install
pnpm test     # vitest — 100 件
```

台帳づくり・衝突検出・lsof の読み取り・整形・引数解釈は `src/lib/` の純粋関数で、ここを固くテストしている。
lsof の読み取りは macOS の実出力(`-F` 形式と表形式の両方)と Linux 形式の IPv6 表記で確かめている。
走査は tmp に本物のフォルダと `git worktree` を作って通している。

## 作りの要点

- `src/lib/` 純粋関数: `extract.js`(設定の文字列→宣言)、`ledger.js`(台帳・衝突・突き合わせ・提案)、`lsof.js`、`format.js`、`args.js`
- `src/io/` 副作用: `scan.js`(フォルダ走査と git の同一判定)、`live.js`(lsof / ps / bind での確認)
- vite.config は実行せずに読む(import すると依存の解決や副作用が要る)。中かっこの入れ子を数えて、`port` が `server` / `preview` / `hmr` のどこにあるかを決める
- lsof は人間向けの表ではなく `-F` 形式(1行1フィールド)を読む。表は版によって列幅・コマンド名の切り詰め・`\x20` エスケープが変わるので保険としてだけ使う

### ハマりどころ

- **iCloud 上のファイルを読むと固まる**。ワークツリーの `.git` が指す先(`~/Documents` 配下の本体の `commondir`)が
  iCloud で「最適化」されていて、`cat` しただけでダウンロード待ちになり戻ってこなかった。
  共通ディレクトリはファイルを読まずにパス(`…/.git/worktrees/<name>` → `…/.git`)から出し、
  サイズがあるのにブロックが 0 のファイル(中身がクラウドだけ)は読まないようにした
- lsof の表形式はコマンド名を9文字で切る(`ControlCe`)うえ空白を `\x20` と書く。`+c 0 -F pcn` で取る
- 開発サーバーは `cwd` が `/` のこともある(ランチャー経由)。プロジェクトの特定は `cwd` に加えて `ps` のコマンドライン中のパスでもする。
  `/r/app` と `/r/apple` を取り違えないよう、前方一致はフォルダ境界で切る
- Vite の `preview.port` の既定は `server.port` ではなく 4173

## ライセンス

MIT
