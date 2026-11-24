# ソースからVardockを実行する

[English](README.md) | 日本語 | [中文](README.zh.md)

セットアップは既定で`unattendedShell: true`を書き込み、ネットワークのない作業環境で日常的なスクリプトを自動実行します。実行許可と結果の証拠は記録され、証拠保全に確認されます。制御部はモデルではなく固定ルールで決まる要所で所有者に確認します。外部への業務リクエストは所有者のルールで許可されない限り待機し、ノートとスケジュールも承認を必要とします。すべてのスクリプトを確認する場合は、セットアップに`--review-scripts`を付けてください。既存環境の設定は変わりません。[既存Profileの切り替え（英語）](../../../../docs/upgrade-guide/v0.2.2-rc.2-vardock/automatic-scripts/guide.md)

VardockはDeepSeek Harness（DSH）を基盤としています。ここで説明するコマンドは、ローカルのWeb Host、操作制御部、証拠保全サービスを準備し、管理します。各サービスはDSHのProfileを通じて起動します。単独の`pnpm dsh web`コマンドは、標準のHarness Web Profileを起動します。 以下はmacOSの手順です。systemdとDockerは[Linux](#linux)を参照してください。

信頼できるmacOSアカウントを使ってください。3つのサービスはあなたのユーザーIDを共有するため、同じIDで動く別のプロセスは、その状態を読み書きし、ソケットに接続し、VMを操作できます。証拠保全は別プロセスですが、別の管理者が管理するものではありません。[脅威モデル](../../../../SAFETY.ja.md#threat-model)

## チェックアウトを準備する

macOS 26以降のAppleシリコン搭載Mac、ネイティブarm64のターミナル、開発用ヘッダー付きのNode.js 24.9以降、Xcode Command Line Tools、ルートのマニフェストの`packageManager`で指定されたバージョンのpnpmを使ってください。これらのmacOSの条件を満たさない場合、コマンドは`Use a native Apple silicon terminal and Node.js on macOS 26 or newer.`と表示して停止します。Appleの`container` CLIをインストールし、`PATH`に追加してください。[ルートのマニフェスト](../../../../package.json) · [Apple Containerのインストール](https://github.com/apple/container#initial-install)

Windowsなど未対応のホストでは、`pnpm vardock --help`は用法を表示します。setup、start、stop、doctor、verifyは`Vardock supports macOS and Linux only.`と表示して停止します。

<a id="choose-a-model-provider"></a>
### モデルプロバイダーを選ぶ

セットアップには`--model-provider <route> --model <id>`が必要です。どちらかがない場合、セットアップは何も変更せずに停止し、2種類のルートを表示します。LLM APIプロバイダーを使う場合、`<route>`は、インストール済みの[pi-aiアダプター（英語）](../../../llm/llm-pi-ai/README.md)のカタログにあり、APIキーを受け付けるプロバイダーのルートです。たとえば`openai`、`anthropic`、`deepseek`、`xai`があります。`<id>`はそのプロバイダーのモデルIDです。制御部は起動時にルートとモデルを確認し、アダプターが認識できない場合は`stderr.log`にエラーを書いて停止します。

セットアップはキーを尋ねません。制御部のProfileでキーに`<ROUTE>_API_KEY`という名前を付けます（例：`OPENAI_API_KEY`）。初回の起動後、プラグインページの**接続**でキーを入力してください。制御部はキーを`<home>/authority/.credentials.yaml`に保存し、再表示しません。キーを保存するまで、モデルリクエストは失敗します。

ローカルCodexを使う場合は、`--model-provider codex-local --model default`を渡します。`default`はそのCodexアカウントのデフォルトモデルを選びます。Codex CLIをインストールして`PATH`に追加し、このmacOSアカウントで`codex login`を実行してログインしてください。ログインしていない場合、セットアップは`Run codex login for this macOS account.`と表示して停止します。モデルリクエストには、そのCodexアカウントとその利用上限が適用されます。セットアップは、ログイン、資格情報のコピー、モデルリクエストの送信を行いません。[ローカルCodex（英語）](../../llm-codex/README.md#use-this-package)

## セットアップして起動する

チェックアウトのルートで、プロバイダーのルートとモデルIDを指定して実行します。

```sh
pnpm install
pnpm vardock setup --model-provider openai --model "<model-id>"
pnpm vardock start
```

ローカルCodexを使う場合は、代わりに`pnpm vardock setup --model-provider codex-local --model default`を実行します。

セットアップは、ホスト、指定されたpnpm、インストール済みの依存関係、`container`コマンド、およびローカルCodexを使う場合はCodexのログインを確認します。続いて`pnpm run build:artifacts`を実行し、Apple Containerが動いていなければ`container system start --enable-kernel-install`で起動します。初回は、Apple ContainerのデフォルトのLinuxカーネルがダウンロードされ、インストールされます。イメージ`dsh-execution:local`がない場合は、[実行用Dockerfile](../../execution-container/Dockerfile)から`container build`でビルドします。このとき、Dockerfileが固定するダイジェストの`node:24-bookworm-slim`を取得し、Debianのパッケージアーカイブから`socat`をインストールします。最後に、非公開のProfileとlaunchdのジョブファイルを`$HOME/.vardock`に書き込み、`Prepared Vardock in <home>. Run pnpm vardock start --home '<home>'.`と表示します。APIプロバイダーのルートを指定した場合は`Then save the model API key under Plugins, Connections.`も表示します。

セットアップはサービスを起動しません。起動コマンドは証拠保全、制御部、Web Hostの順に読み込み、それぞれの準備完了を待ってから`Vardock is ready.`と表示し、既定のブラウザーで入口を開きます。

Web Hostは[Assistantパッチ](../cordis.patch.yml)を読み込みます。このパッチはWeb ProfileのOffice変換（`office-kit`）、Officeスキル（`skill-office`）、アカウント通知のポーリング（`ui-account-notifications`）、MCPサーバーマネージャー（`mcp-manager`）、DeepSeekアカウントサービス（`deepseek-account`）、Sessionテレメトリーの送信（`session-telemetry-otel`）を無効にします。そのためHostはOfficeの出力を書き込まず、Officeスキル用にPythonを実行せず、設定からMCPサーバーを起動せず、アカウントサーバーをポーリングせず、Sessionテレメトリーを送信せず、文書プレビューはOfficeファイルを表示しません。

チェックアウトの場所は変えないでください。生成されたProfileは、そこでビルドされたパッケージを参照します。セットアップは既存の環境を上書きせず、許可、資格情報、保存済みの仕事をリセットしません。ビルドやイメージの準備に失敗した場合は、Profileを生成する前に停止します。

## 環境を管理する

| コマンド | 動作 |
|---|---|
| `pnpm vardock setup` | 新しい環境を準備します。 |
| `pnpm vardock start` | サービスを起動するか、実行中の環境を開き直し、`Vardock is ready.`と表示します。 |
| `pnpm vardock stop` | Web、制御部、証拠保全を停止します。データと共有のContainerサービスは残します。`Vardock is stopped.`と表示します。 |
| `pnpm vardock doctor` | 前提条件と環境の状態を変更せずに確認します。確認項目ごとに`OK  <check>`または`Fix <check>. <action>`を表示し、失敗した項目があれば終了ステータス1で終わります。 |
| `pnpm vardock verify` | Vardockの実行中に使います。証拠保全のすべてのイベントを読み、操作の各イベントを制御部の受領記録と突き合わせ、`OK  Every compared event matches.`を表示するか、問題ごとに`Mismatch`の行とその種類が意味し得る内容を表示して終了ステータス1で終わります。証拠保全の確認後、制御部が自身の記録を確定する前に停止した場合も`receipt-missing`になります。証拠保全が一度も受け取らなかった制御部の記録は報告されません。何も変更しません。 |

別の環境ディレクトリを使うには`--home /short/path`を付けます。すべてのコマンドで同じパスを使ってください。

セットアップに`--port 3080`を付けると、自動割り当ての代わりにそのポートを使います。起動に`--no-open`を付けると、ブラウザーを開きません。使い方は`pnpm vardock --help`で確認できます。

launchdのジョブは固定のラベル`io.github.virtualhatch-inc.vardock.witness`、`.authority`、`.web`を使うため、macOSのデスクトップセッションごとに有効な環境は1つだけです。別のディレクトリの環境がこれらのラベルを使っている場合は、その環境の`--home`を指定して停止してから、この環境を起動してください。コマンドがほかの環境を引き継いだり停止したりすることはありません。以前のラベル`io.deepseek.dsh.assistant-dev.<role>`で準備した環境が読み込まれているか、選んだディレクトリにある場合も、コマンドは実行を拒否し、移行の手順を表示します。[アップグレードガイド（英語）](../../../../docs/upgrade-guide/v0.2.2-rc.2/vardock-launchd-labels/guide.md)

起動コマンドは、ログイン中のmacOSデスクトップセッションで実行します。ログアウトやMacの再起動の後は、もう一度実行してください。読み込まれたジョブのプロセスが終了すると、launchdが再起動します。停止はジョブを解除するだけで、Session、操作記録、VMの作業用ボリュームは削除しません。

<a id="default-grant"></a>
### 既定の許可

セットアップは次の許可を制御部のProfileに書き込みます。仕事はShellスクリプトを実行でき（`exec: true`）、ファイルを取り込み・書き出し、モデルとあなたに開示でき、外部アクションの応答テキストを受け取れます（`returnResponses`を含むすべての`data`権限）。Brokerのアクションは依頼できません（`brokerActions: []`）。この許可は上限であり、各委任はその範囲内で仕事に必要な権限を指定します。予約は1,000回（`maxOperations`）、期限はセットアップの7日後（`grantExpiresAt`）、転送できるのは1ファイル8 MiBまでです。予約の上限と期限は、入口の**利用設定**で変更します。権限は、Vardockを停止した状態で、[サービスを接続する](#connect-a-service)と同じ方法で`operation-control`の行の`assistant.permissions`を編集して変更します。`unattendedShell`はその行でしか設定できず、変更できるページはありません。

セットアップは次の制限を書き込みます。制御部の値はVardockを停止した状態で`<home>/authority/profiles/operation-authority/cordis.patch.yml`で、Webの値は表に示す`--patch`ファイルで変更します。

| 設定 | 値 | 場所 | 理由 |
|---|---|---|---|
| `grantExpiresAt` | セットアップの7日後 | `operation-control`の行 | 許可を更新しない限り、評価用の1週間が過ぎると仕事を受け付けません。 |
| `maxOperations` | 1,000 | `operation-control`の行 | モデルへの依頼ごとに予約を1回使うため、暴走したループを止めつつ1週間の評価に足ります。 |
| `maxFileBytes` | 8 MiB | `operation-control`の行 | Assistantの1ファイルあたりの読み取り上限と同じなので、Hostと制御部が同じファイルを受け付けます。 |
| `timeoutMs` | 5分 | `execution-container`の行 | 作業環境の起動を含め、1つのスクリプトはこの時間まで実行できます。パッケージ既定の30秒では、起動とファイル処理に足りません。 |
| `gatewayIdleTimeoutMs` | 5分 | `execution-container`の行 | スクリプトの制限時間と同じなので、まだ実行中かもしれないスクリプトのアイドル接続をゲートウェイが閉じません。 |
| `timeoutMs` | 6分 | [`cordis.patch.yml`](../cordis.patch.yml)の`operation-control-agent`の行 | スクリプトの制限時間より長いので、Hostが先に依頼を放棄せず、制御部のタイムアウト結果を受け取ります。 |
| `maxActive` | 2 | [`cordis.patch.yml`](../cordis.patch.yml)の`assistant`の行 | 仕事のSessionはそれぞれ独自の作業環境とモデルへの依頼を使うため、2つに抑えて同時の資源使用を制限します。 |
| `assistant.permissions.data` | 4つとも`true` | `operation-control`の行 | [最初の仕事](#try-a-first-work-request)で、設定を編集せずに添付ファイルを取り込み、レポートを返せます。 |

転送と開示を絞るには、`assistant.permissions.data`の`import`、`export`、`discloseToModel`、`discloseToUser`のいずれかを`false`にします。取り込みと書き出しにはそれぞれ両方の開示権限が必要で、`data`を削除するとすべての転送が拒否されます。

## 問題を診断する

`pnpm vardock doctor`を実行し、表示された次の対処に従ってください。前提条件とサービスの待ち受け状態を確認します。有効な上限と仕事の結果は入口のUIで確認してください。ローカルCodexでは、モデルリクエストにCodexのログインが有効であることが必要です。APIプロバイダーでは、保存済みのキーが必要です。サービスを起動しても、操作の許可は更新されません。

起動が途中で失敗した場合、コマンドは影響を受けたサービスを示します。`pnpm vardock stop`でこの環境のジョブを解除し、原因を解決してから再度起動してください。サービスを停止しても、完了済みの外部への影響は取り消されません。

非公開のログは`$HOME/.vardock/{web,authority,witness}/stdout.log`と`stderr.log`、または対応する`--home`にあります。Webの起動URLには所有者のアクセストークンが含まれます。macOSでは管理コマンドはこれを表示しません。ログは非公開にし、機密情報を取り除かずに公開Issueへ貼り付けないでください。

<a id="try-a-first-work-request"></a>
## 最初の仕事を試す

プロンプトを送る前に、入力欄の上にある**アシスタントの作業**で、許可の残りの予約と期限を確認してください。予約は、モデルリクエスト、Shell、Broker、ファイル転送、委任、入口の応答で共有されます。外部アクションを1つ含む委任では、予約をおよそ20回使います。

**サンプルを試す**を選ぶと、空の入力欄にCSVとレポートの依頼が用意されます。内容を確認して送信してください。会話はモデルリクエストを設定済みのモデルプロバイダーへ送ります。スクリプトは自動実行され、証拠は記録されて証拠保全に確認されます。`--review-scripts`で設定した場合は、承認カードでスクリプトを確認して**1 回だけ許可**を選んでください。仕事から返されたレポートを開き、プレビューまたはダウンロードしてください。[Assistantの操作（英語）](../README.md#use-this-package)

macOSとLinuxでは、マイクをクリックして初回利用の案内を開き、プラグインページの**音声入力**で認識サービスと言語を選び、ローカルモデルのダウンロードと準備を開始します。モデルのダウンロードには、再試行を含め、明示的な準備リクエストが必要です。

macOSでは作業Sessionは、最初のファイル取り込みまたはShellコマンドの時点で、LinuxのマイクロVMと非公開の作業領域を得ます。ゲストにはループバックのネットワークしかありません。操作用と承認用のソケットはHost側にあります。ファイルは明示的な転送によってのみVMに出入りします。仕事の結果を通じて開示されたデータは、設定済みのモデルプロバイダーに届きます。外部の業務アクションは既定で無効です。

予約の上限と期限は、入口の**利用設定**で変更します。保存した上限は再起動後も残り、Profileの初期値より優先されます。既存の予約は引き続き数えられ、保存しても中断された仕事は再開しません。仕事を確認してから明示的に続行してください。結果不明の外部操作には**結果を確認**を使います。予約枠の補充や結果不明の状態の解消のためにデータベースを削除しないでください。

[6段階の在庫練習（英語）](../../../../examples/practice/README.md)では、外部サービスのアカウントなしで、リクエストの承認、証拠保全に確認された記録、処理結果の確認、読み取りの自動実行と更新の承認待ちを体験できます。

<a id="connect-a-service"></a>
## サービスを接続する

新しいデプロイでは、`--model-provider` と `--model` に加え、繰り返し指定できる `--authority-patch /absolute/path/service.yml` と `--permit-action <action-id>` を渡します。Setup は生成した制御部のパッチの後に補足パッチを合成し、指定した ID を `assistant.permissions.brokerActions` に書き込みます。`--permit-action` を省略すると、生成する一覧は空のままです。HTTPS broker だけを変更するパッチには、`routes` を含む完全な `operation-broker` 設定が必要です。モデル、有効期限、その他の制御部設定は setup の選択に従います。読み取れないパッチ、形式が不正なパッチ、対象行が存在しないパッチは、プロファイルの書き込み前に setup を失敗させます。制御部は起動時にプラグイン設定を検証し、ルートが提供しない操作 ID を拒否します。start と doctor は、その非公開の `stderr.log` と制御部のパッチファイルを示します。合成後のプロファイルにパッチが保存されるため、起動時に元のファイルは不要です。パッチの `config` は行の設定全体を置き換えます。[Loader 設定](../../../../docs/cordis-primer.md#loader-configuration)

非公開の認証局を使うサービスには、HTTPS JSONルートまたはMCPサーバーの行に`ca: /absolute/path/company-ca.pem`を設定します。そのルートまたは接続先だけがPEM証明書を信頼し、証明書とホスト名の検証は有効なままです。制御部がファイルを読める状態を保ってください。変更後は再起動します。パスと内容のダイジェストがルートを識別するため、変更したルートの保存済み所有者ルールは無効になり、次の起動で変更後の設定が証拠保全に記録されます。[BrokerのCA設定（英語）](../../operation-broker/README.md#private-certificate-authorities)

「読み取りは自動、送信は確認」にするには、両方のBrokerアクションを設定し、`assistant.permissions.brokerActions: [read-records, send-message]`に両方を含めます。アクション名が方針を決めるのではなく、所有者がルールを指定します。この設定では次のようになります。

| 操作 | 制御部の設定 | 所有者に見えるもの |
|---|---|---|
| レコードを読む | `unattendedBrokerActions: [{ action: read-records }]`、読み取りルートに`returnResponse: true` | 承認カードなし。業務記録に依頼と結果、証拠保全の証拠が残ります。 |
| メッセージを送る | `send-message`に承認なしルールを設定しない | 接続先と保存された正確な依頼の承認カード。所有者の判断まで送信を待ちます。 |
| スクリプトを実行する | `unattendedShell: true`、`backend: apple-vm`、`allowedTargets: []` | スクリプトの承認カードなし。実行出力と証拠保全の受領記録が残ります。 |

Vardockが外部へ依頼を送るのは、制御部のProfileで設定され、許可で認められたアクションを通じた場合だけです。アクションは、HTTPS JSON Broker（セットアップはルートなしで読み込みます）のルート、またはリモートMCPサーバーのツールです。[Brokerの設定（英語）](../../operation-broker/README.md#use-this-package)

1. `pnpm vardock stop`を実行します。
2. `<home>/authority/profiles/operation-authority/cordis.patch.yml`を開きます。`<home>`は`$HOME/.vardock`または指定した`--home`です。セットアップは既定でJSON、制御部パッチの適用時はYAMLを書き込み、Profileのローダーはどちらも読み込みます。ファイルには1つのレイヤーがあり、その`insert`リストに制御部のプラグインの行が`id`付きで並んでいます。
3. 以下の説明に従い、アクションをHTTPS JSONルートまたはMCPツールとして追加します。
4. `operation-control`の行の`config`で、各アクションIDを`assistant.permissions.brokerActions`に追加します（例：`"brokerActions": ["example-create"]`）。`execution-container`の行の`allowedTargets: []`はそのままにしてください。CONNECTの接続先がある場合、制御部はBrokerの依頼を拒否します。
5. ファイルを非公開に保ちます。このファイル、同じディレクトリの`package.json`、launchdのジョブファイルが、あなたの所有でグループやその他のユーザーの権限を持たない通常のファイルでない限り、起動コマンドは実行されません。エディターが権限を変えた場合は、ファイルに`chmod 600`を実行してください。
6. `pnpm vardock start`を実行します。この起動で制御部は変更後の設定を証拠保全に記録させ、証拠保全が確認するまでリクエストを受け付けません。その間、制御部へのリクエストはすべて`configuration-evidence-unavailable`で失敗し、`<home>/authority/stderr.log`には確認されなかった各試行が記録されます。制御部が準備完了にならない場合は、同じログで設定のエラーを確認してください。
7. プラグインページの**接続**で、アクションのトークンを入力します。制御部はトークンをアクションの`credentialRef`の名前で保存し、再表示しません。受け付けるのはBearerトークンの形式のテキストだけです。
8. 必要に応じて、同じページでアクションの承認なしルールを追加します。

HTTPS JSONルートを追加するには、`operation-broker`の行の`config.routes`に項目を追加します。Brokerは作業AgentのJSON本文を`POST`で`endpoint`に送り、保存済みのトークンをBearerトークンとして付けます。

```json
{
  "action": "example-create",
  "description": "Create one item. The body is {\"title\": string}.",
  "endpoint": "https://api.example.com/v1/items",
  "credentialRef": "EXAMPLE_API_TOKEN"
}
```

`action`は仕事が依頼に使うIDで、小文字の英字で始まり、その後に最大63文字の小文字の英字、数字、`.`、`_`、`-`が続きます。`description`はそのままモデルに渡されます。アクションの内容と受け付けるJSON本文を書いてください。`endpoint`は、ユーザー情報やフラグメントを含まない正規のHTTPS URLです。`credentialRef`はトークンの名前で、英字、数字、`_`を使い、数字で始めることはできません。省略可能な`returnResponse: true`は応答テキストを作業Agentに返すため、そのテキストはモデルにも届きます。省略可能な`reconciliationEndpoint`を指定すると、読み取り専用の結果照合ができます。`Authorization`、`Content-Type`、ブローカーの`User-Agent`以外のリクエストヘッダーを必要とするAPIには、HTTPSルートでは接続できません。そのAPIがMCPサーバーを提供している場合は、そちらを使ってください。[ルートの項目（英語）](../../operation-broker/README.md#example-route)

リモートMCPサーバーのツールを呼び出すには、`insert`リストに行を追加します。

```json
{
  "id": "operation-broker-mcp",
  "name": "@deepseek-ai/dsh-operation-broker/mcp",
  "config": {
    "servers": [
      {
        "url": "https://mcp.example.com/mcp",
        "credentialRef": "EXAMPLE_MCP_TOKEN",
        "tools": [
          {
            "action": "example-search",
            "tool": "search",
            "description": "Search items. The body is {\"query\": string}.",
            "returnResponse": true
          }
        ]
      }
    ]
  }
}
```

次に、`operation-control`の行の2つのリストに`operationBrokerMcp`を追加します。制御部がこのProviderを待つための`inject`を`["operationBroker", "operationBrokerMcp"]`にし、`config.broker`も同じリストにします。`tool`はサーバーが示すツール名です。表にないツールは呼び出せません。サーバーはStreamable HTTPに対応し、`Authorization`のBearerトークンを受け付ける必要があります。OAuthが必要なサーバーやローカルプロセスとして動くサーバーには対応していません。たとえばGitHubは、`https://api.githubcopilot.com/mcp/`のリモートMCPサーバーが個人アクセストークンをBearerトークンとして受け付けると説明しています。このプロジェクトでは検証していません。[MCPツール（英語）](../../operation-broker/README.md#mcp-tools)

Profileを変更すると、許可のリビジョンが変わります。まだ使われていない承認と許可証は無効になり、以前に委任した仕事は以前の権限のままです。新しいアクションを使うには、新しい仕事を委任してください。その後ルートやMCPツールを変更すると、所有者が保存した承認なしルールも無効になります。[承認なしルール](../../../../SAFETY.ja.md#approval-recovery-and-completion)

## 統合テストを実行する

Codex、Apple VM、テスト専用のループバックHTTPSエンドポイントを使う任意のテストでは、Webテストの手順に従ってChromiumをインストールします。セットアップでビルドと実行イメージを準備した後、チェックアウトのルートで次のコマンドを実行してください。[Webテストの手順（英語）](../../../../apps/web/tests/README.md)

```sh
DSH_ASSISTANT_REAL_E2E=1 DSH_ASSISTANT_SCREENSHOT_DIR="$PWD/.artifacts/assistant-real" \
  pnpm run test:web:built apps/web/tests/assistant-real.e2e.ts
```

このテストは一時的なProfileとあなたのCodexアカウントを使います。承認、応答が失われた後の読み取り専用の結果照合、成果物のダウンロードを確認します。スクリーンショット、ダウンロードしたファイル、受領記録の要約を指定したディレクトリに保存します。

## 環境を削除する

`pnpm vardock stop`を実行してから、環境ディレクトリ（`$HOME/.vardock`または指定した`--home`）を削除します。このディレクトリには、Profile、launchdのジョブファイル、ログ、Session、保存済みのキーとトークン、制御部と証拠保全のデータベースが含まれます。削除するとすべての記録が失われ、元に戻せません。

Apple Containerには、作業Sessionごとに`dsh-vm-<12 hexadecimal characters>-<32 hexadecimal characters>`という名前のVMとその作業用ボリュームが残ります。また、このMac上のすべての環境が共有するイメージ`dsh-execution:local`も残ります。`container list --all`、`container volume list`、`container image list`で一覧を表示し、`container delete`、`container volume delete`、`container image delete`で削除します。

<a id="separate-service-accounts"></a>
## 別のサービスアカウント

管理コマンドは、macOSまたはLinuxで同一アカウントの環境を対象とします。別々に管理する環境では、Web Host、制御部、証拠保全にそれぞれ別のアカウント、非公開のホームディレクトリ、運用者が所有する成果物を用意してください。制御部のアカウントには専用のモデル資格情報を与え、実行バックエンドへのアクセスを独占させてください。[制御部とソケットの所有権（英語）](../../operation-control/README.md#use-this-package) · [証拠保全（英語）](../../operation-evidence/README.md#use-this-package)

<a id="linux"></a>
## Linux

信頼できるLinuxアカウントを使い、開発用ヘッダー付きNode.js 24.9以降、指定されたpnpm、`lsof`、systemdユーザーサービス（`systemctl`、`systemd-analyze`、`systemd-run`、`loginctl`）、Dockerを用意します。3つのサービスは同じユーザーIDで動きます。rootful Dockerでは、`docker`グループのメンバーはホストをroot相当の権限で制御できます。同じユーザーの証拠保全プロセスは独立した証拠ストレージではありません。[Dockerへのアクセス](https://docs.docker.com/engine/install/linux-postinstall/)

lingeringを有効にし、ログアウト後も実行し、ホスト起動後に再開できるようにします。無効な場合、setupとdoctorは失敗し、所有者が実行する正確な`sudo loginctl enable-linger <uid>`コマンドを表示します。sudoは実行しません。Dockerグループに追加した後はユーザーサービスマネージャーを再起動し、接続し直します。診断には`sudo systemctl restart user@<uid>.service`が表示されます。この操作はそのアカウントのすべてのユーザーサービスを停止します。新しいShellのグループ情報だけではマネージャーは更新されません。

ローカルの`unix://`ソケットを使うDockerコンテキストを選びます。setupとdoctorはcgroup v2、メモリー制限、PID制限、CPU CFSクォータ、登録済みの選択したランタイムを要求します。`systemd-run --user`で一時的な`docker info`を実行し、マネージャーからのアクセスを確認します。

Linuxでは`--runtime`を指定します。既定値はなく、macOSはこのオプションを拒否します。doctorはランタイムとその制限を表示します。

| ランタイム | 隔離と制限 |
|---|---|
| `runc` | ホストのカーネルを共有する通常のコンテナで、VMの隔離境界ではありません。 |
| `runsc` | gVisorのユーザー空間カーネルを使います。PID制限はサンドボックスのHost側タスクを数え、ゲストのプロセス数は制限しません。 |
| `kata` (`io.containerd.kata.v2`) | 種類としてはVMの隔離境界を提供し、KVMが必要です。本プロジェクトでは未検証です。 |

先にランタイムをインストールして登録します。Kataにはrootful Dockerと動作するKVMが必要です。doctorはランタイムの登録、デーモンの機能、サービスのリスナーを確認します。作業コンテナの起動や隔離は検証せず、登録済みのランタイムが起動できなくても成功する場合があります。実際のライフサイクルと実行を確認したのは、Docker 29.9、runc、runscを使う1台のarm64 Ubuntu VMです。Kata、x86_64、その他のディストリビューション、rootless Dockerは未検証です。対象ホストで起動、再起動、作業実行を確認してください。

実際の Linux 実行で `EXEC_STOP_UNKNOWN` が一度報告されましたが、再現しておらず、原因は不明です。発生すると、作業には結果が不明と表示されます。コンテナの停止を確認し、作業のワークスペースの結果と**業務記録**にある外部操作の結果を調べてから、リクエストを再試行するか判断してください。

チェックアウトのルートで、プロバイダーとモデルを置き換え、すべてのコマンドで同じ短い非公開のホームを使います。

```sh
pnpm install
pnpm vardock setup --home /short/vardock --model-provider openai --model "<model-id>" --runtime runsc --port 3080
pnpm vardock start --home /short/vardock
pnpm vardock doctor --home /short/vardock
```

ローカルCodexではデプロイ用アカウントで`codex login`を実行し、`--model-provider codex-local --model default`に置き換えます。APIキーは起動後に**接続**で保存します。setupはチェックアウトをビルドし、イメージがない場合は`docker build -t dsh-execution:local packages/experimental/execution-container`で`dsh-execution:local`を作成します。制御部のDocker行にはソケット、ランタイム、ゲートウェイソケット、イメージ、実行とゲートウェイの5分のタイムアウトを設定します。[モデルプロバイダー](#choose-a-model-provider) · [既定の許可](#default-grant)

setupはホームに`io.github.virtualhatch-inc.vardock.{witness,authority,web}.service`をモード0600で書き込み、ログもモード0600で事前作成します。startは`systemctl --user enable --now <absolute-unit-path>`で証拠保全、制御部、Webの順に有効化し、各サービスの準備完了を待ちます。ユニットはプロセス終了後30秒で再起動し、`default.target`で起動します。ホスト再起動後、`After=`だけではアプリの準備完了を待ちません。固定の名前のためユーザーごとに1つだけ使えます。別のホームから読み込まれたユニットは拒否します。

Linuxのstartは認証用Web URLを表示し、ブラウザーを開きません。`--no-open`も受け付けます。URLとログには所有者のアクセストークンが含まれるため非公開にしてください。リモート環境には同じローカルポートを転送します。たとえば`ssh -N -L 3080:127.0.0.1:3080 user@host`を実行し、表示された`http://127.0.0.1:3080/?token=…`をローカルで開きます。Cookieはホストとポートに結び付くため、同じ表記とポートを使ってください。

削除するには`pnpm vardock stop --home /short/vardock`を実行し、Web、制御部、証拠保全を順に無効化して停止します。stopは各ユニットの`TimeoutStopSec`に従ってsystemdが停止を完了するまで待ちます。保存済みの仕事、資格情報、許可、証拠記録が不要な場合だけホームを削除します。Dockerの作業コンテナー、作業用ボリューム、共有イメージは残ります。`docker ps --all`、`docker volume ls`、`docker image ls`で確認し、不要と確認したリソースだけ削除してください。
