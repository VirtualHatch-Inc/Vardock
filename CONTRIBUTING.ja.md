# Vardockへの貢献

[English](CONTRIBUTING.md) | 日本語 | [中文](CONTRIBUTING.zh.md)

VardockはDeepSeek Harnessを独自にカスタマイズしたものです。Vardockの動作や変更の提案は、このリポジトリで議論してください。Vardock固有のサポート依頼を上流のDSHの管理者に送らないでください。参加には[行動規範](CODE_OF_CONDUCT.ja.md)が適用されます。

## 問題を報告する

影響を受けるコンポーネント、OS、バージョン、最小の再現手順、期待される動作、実際の結果を記載してください。ログからはアクセストークン、資格情報、非公開の入力、Sessionの内容を取り除いてください。機密性のある報告は[安全性](SAFETY.ja.md#local-operation-and-reports)に従ってください。

## 変更を加える

変更は小さく保ち、DSHのサービスとCordisの拡張ポイントを再利用してください。[AGENTS.md（英語）](AGENTS.md)、[アーキテクチャ（英語）](docs/architecture.md)、[開発ガイド（英語）](docs/development.md)を読んでください。動作が変わる場合は、その動作を説明する文書と、その対になる言語版を更新してください。

変更したコンポーネントに適したチェックを実行し、実行したコマンドと結果を報告してください。ユニット、スナップショット、Provider、ビルドの各チェックは[テストガイド（英語）](docs/testing.md)で説明しています。実行時のホームディレクトリ、ローカルの資格情報、データベースの内容、生成されたビルド成果物を貢献に含めないでください。

上流の著作権表示、ライセンス表示、帰属表示を維持してください。ソースコードの貢献にはこのリポジトリの[MITライセンス](LICENSE)が適用されます。追加する依存関係と、提供するアートワークやその他の素材の再配布条件を明示してください。

## 配布

サポートする評価方法は[ソースからのmacOSセットアップ](packages/experimental/assistant/vardock/README.ja.md)です。継承したnpm、デスクトップ、Python、Webサイトの公開スクリプトはDSHのインフラを対象としており、Vardock用の別のリリース設定と再配布のレビューが必要です。リポジトリのソースを公開しても、それだけで同梱するすべての依存関係の再配布が認められるわけではありません。

## バージョン

Vardockのバージョンは、公開リポジトリ上の注釈付きGitタグで、名前は`vardock-vMAJOR.MINOR.PATCH`、リリース候補では`vardock-vMAJOR.MINOR.PATCH-rc.N`です。ほかのリポジトリはこのタグでVardockのバージョンを固定します。`dsh-v*`タグは上流のDSHのリリースを示すもので、Vardockのバージョンではありません。[ワークスペースの制約](scripts/check-workspace-constraints.ts)がすべての`@deepseek-ai/dsh*`パッケージにルートのバージョンを持たせることを求めるため、ルートの`package.json`は上流のDSHのバージョンのままです。各タグのメッセージには、そのバージョンが基づく上流のリリースを`Based on dsh-v0.2.2-rc.2`のように記載します。

特定のタグのVardockをインストールするには、そのタグでリポジトリをクローンし、`pnpm install --frozen-lockfile`を実行してから、[macOSセットアップガイド](packages/experimental/assistant/vardock/README.ja.md)のとおりにモデルの経路を指定して`pnpm vardock setup`を実行します。生成されたProfileはチェックアウト内のビルド済みパッケージを参照するため、チェックアウトはそのまま残してください。
