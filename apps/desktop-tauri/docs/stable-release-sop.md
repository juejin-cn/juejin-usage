# Tauri 1.0.0 正式发版与 Electron 迁移 SOP

前提：Electron 0.1.16 过渡版已发布，Gitee `releases/*.yml` 指向 0.1.16，`releases/electron-to-tauri.json` 为 `enabled: false`。

每步做完勾选再往下。命令均在仓库根执行。

```bash
export VERSION=1.0.0
export TAG=v1.0.0
export REPO=juejin-cn/juejin-usage
export OUT=~/Releases/jusage-tauri/$VERSION
```

---

## 0. 观察过渡版

- [x] 0.1.16 已推送 1～2 天，日志与反馈中无自动更新异常
- [x] 本机一台旧版（≤0.1.15）能升到 0.1.16

迁移开关关闭时，0.1.16 的表现与普通版本一致。

---

## 1. 生成 Tauri 更新签名密钥（一次性）

```bash
mkdir -p ~/.tauri
pnpm --filter @juejin-opensource/jusage-desktop-tauri exec \
  tauri signer generate -w ~/.tauri/jusage-stable.key
```

- [x] 记下设置的密码
- [x] 备份 `~/.tauri/jusage-stable.key` 和 `.key.pub` 到密码管理器

> 私钥丢失后，已安装的 Tauri 客户端将无法再接收更新。

---

## 2. 确认 Apple 证书与公证 Key（复用本地 Electron 构建所用）

复用 `~/Downloads/Certificates.p12` 与 `~/Downloads/JJMacOS.Notary.Key.p8`。Key ID、Issuer ID 与本地 Electron 构建的 `APPLE_API_KEY_ID`、`APPLE_API_ISSUER` 相同。

确认 `.p12` 内是 Developer ID 证书且带私钥（会提示输入导出密码）：

```bash
openssl pkcs12 -in ~/Downloads/Certificates.p12 -info -nodes -legacy 2>/dev/null \
  | grep -E 'subject=|BEGIN PRIVATE KEY'
```

- [x] 输出含 `Developer ID Application: Bill Sun (H8Y245QGXB)` 和 `BEGIN PRIVATE KEY`

不符或忘记密码时，从钥匙串重新导出：钥匙串访问 → 我的证书 → 该证书 → 右键导出 `.p12`。

---

## 3. 配置 GitHub Secrets / Variables

仓库 → Settings → Secrets and variables → Actions。

**Secrets**

| 名称 | 值 |
|------|----|
| `APPLE_CERTIFICATE` | `Certificates.p12` 的 base64 |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` 导出密码 |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Bill Sun (H8Y245QGXB)` |
| `APPLE_API_KEY` | Key ID（本地的 `APPLE_API_KEY_ID`，不是 `.p8` 路径） |
| `APPLE_API_ISSUER` | Issuer ID（本地的 `APPLE_API_ISSUER`） |
| `APPLE_API_PRIVATE_KEY` | `JJMacOS.Notary.Key.p8` 文件全文 |
| `TAURI_SIGNING_PRIVATE_KEY` | `~/.tauri/jusage-stable.key` 全文 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 第 1 步密码 |
| `TUD_WINDOWS_CERTIFICATE` | Windows 代码签名 `.pfx` 的 base64（没有则不填） |
| `TUD_WINDOWS_CERTIFICATE_PASSWORD` | `.pfx` 密码（没有则不填） |

**Variables**

| 名称 | 值 |
|------|----|
| `TUD_UPDATER_PUBLIC_KEY` | `~/.tauri/jusage-stable.key.pub` 全文（原样粘贴） |
| `TUD_UPDATER_URL` | `https://gitee.com/juejin-cn/juejin-usage/raw/main/releases/tauri/latest.json` |
| `TUD_WINDOWS_TIMESTAMP_URL` | 有 Windows 证书时填，如 `http://timestamp.digicert.com` |

也可用命令行：

先在同一终端 export 本地 mac 签名构建用的 `APPLE_API_KEY_ID`、`APPLE_API_ISSUER`：

```bash
: "${REPO:?}" "${APPLE_API_KEY_ID:?}" "${APPLE_API_ISSUER:?}"
base64 -i ~/Downloads/Certificates.p12 | gh secret set APPLE_CERTIFICATE -R $REPO
gh secret set APPLE_SIGNING_IDENTITY -R $REPO \
  --body 'Developer ID Application: Bill Sun (H8Y245QGXB)'
gh secret set APPLE_API_KEY -R $REPO --body "$APPLE_API_KEY_ID"
gh secret set APPLE_API_ISSUER -R $REPO --body "$APPLE_API_ISSUER"
gh secret set APPLE_API_PRIVATE_KEY -R $REPO < ~/Downloads/JJMacOS.Notary.Key.p8
gh secret set TAURI_SIGNING_PRIVATE_KEY -R $REPO < ~/.tauri/jusage-stable.key
gh variable set TUD_UPDATER_PUBLIC_KEY -R $REPO < ~/.tauri/jusage-stable.key.pub
gh variable set TUD_UPDATER_URL -R $REPO \
  --body https://gitee.com/juejin-cn/juejin-usage/raw/main/releases/tauri/latest.json
```

两个密码单独执行，各自提示输入（`.p12` 导出密码、第 1 步密钥密码）：

```bash
gh secret set APPLE_CERTIFICATE_PASSWORD -R $REPO
```

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD -R $REPO
```

- [x] `gh secret list -R $REPO` 与 `gh variable list -R $REPO` 能看到以上条目

---

## 4. 构建 Draft Release

```bash
gh workflow run tauri-release.yml -R $REPO -f version=$VERSION -f draft=true
gh run watch -R $REPO "$(gh run list -R $REPO -w tauri-release.yml -L 1 --json databaseId -q '.[0].databaseId')"
```

或在 Actions → **Tauri stable release** → Run workflow 中填 `version=1.0.0`、`draft=true`。

无需手动打 tag：Release 记录构建所用提交，发布（第 6 步）时自动在该提交上创建 `v1.0.0`。

- [x] 三个构建任务（mac arm64 / mac intel / windows）与 publish 全绿
- [x] Draft `v1.0.0` 附件齐全：

| 文件 | 用途 |
|------|------|
| `Juejin.Usage-1.0.0-arm64.dmg` | Apple 芯片安装包 |
| `Juejin.Usage-1.0.0.dmg` | Intel 安装包 |
| `Juejin.Usage.Setup.1.0.0.exe` | Windows 安装包 |
| `*-mac.app.tar.gz` + `.sig`（两份） | mac 更新包 |
| `Juejin.Usage.Setup.1.0.0.exe.sig` | Windows 更新签名 |
| `SHA256SUMS-*` | 每端校验和 |

---

## 5. 验收安装包

从 Draft 下载安装包，在真机上安装（覆盖现有 Electron 版）。

```bash
mkdir -p $OUT/release && cd $OUT/release
gh release download $TAG -R $REPO -p '*.dmg' -p '*.exe'
spctl -a -vv -t install Juejin.Usage-1.0.0-arm64.dmg   # 期望 accepted / Notarized Developer ID
cd -
```

- [x] mac：DMG 打开无"无法验证开发者"提示；拖入「应用程序」时提示替换旧版
- [x] mac：启动后原有数据（`~/.ai-usage/`）、登录态都在
- [x] Windows：安装向导覆盖旧版，开始菜单只有一个入口，数据都在
- [x] 面板能正常显示用量、上传正常

有问题：删除 Draft，修复后回到第 4 步。

---

## 6. 发布 Release，同步 Gitee

> 发布后下载页即开始给新用户提供 Tauri 版本（下载页按版本号取最新的 Release，Gitee 没有安装包时回落 GitHub）。

先在 Gitee 仓库页点「同步」，确认 Gitee `main` 已包含 Release 的目标提交，否则 Gitee 无法创建 `v1.0.0` tag。

```bash
gh release edit $TAG -R $REPO --draft=false --latest=false \
  --title "🚀 $TAG" --notes-file $OUT/notes.md
```

`sync-release.yml` 随之在 Gitee 创建 `v1.0.0`（只有标题和说明）。若失败（`创建标签失败`），Gitee 同步后重跑该 Job：

```bash
gh run rerun -R $REPO "$(gh run list -R $REPO -w sync-release.yml -L 1 --json databaseId -q '.[0].databaseId')"
```

- [ ] Gitee 发行版 tag 为 `v1.0.0`（带 `v`），指向与 GitHub 相同的提交
- [ ] 上传到 Gitee `v1.0.0`，文件名保持与 GitHub 一致（带点）：
  - `Juejin.Usage-1.0.0-arm64.dmg`、`Juejin.Usage-1.0.0.dmg`、`Juejin.Usage.Setup.1.0.0.exe`
  - `Juejin.Usage-1.0.0-arm64-mac.app.tar.gz`、`Juejin.Usage-1.0.0-mac.app.tar.gz`（更新源用）
- [ ] 打开线上下载页，三端按钮都指向 1.0.0

---

## 7. 合并 Tauri 更新源 PR

第 4 步构建完成后，**Tauri stable release** 会自动开 PR：

`chore/tauri-feed-$VERSION` → `main`（只改 `releases/tauri/latest.json`）

Gitee 附件上传完毕后再 merge（未传附件就 merge，客户端可能提示更新但下载失败）。

```bash
gh pr list -R $REPO --head chore/tauri-feed-$VERSION --state open
# 确认后在 GitHub 点 Merge，或：
# gh pr merge -R $REPO --merge <pr-number>
```

- [ ] PR 已 merge，`releases/tauri/latest.json` 的 `version` 为 `$VERSION`
- [ ] Gitee 仓库点「同步」后，raw 返回新版本：`https://gitee.com/juejin-cn/juejin-usage/raw/main/releases/tauri/latest.json`
- [ ] 每个 `url` 返回 200，且与 GitHub 构建产物一致：

```bash
node -p "Object.values(require('./releases/tauri/latest.json').platforms).map(p=>p.url).join('\n')" \
  | while read u; do n=$(basename "$u"); curl -sL -o /tmp/$n "$u"
      [ "$(shasum -a 256 < /tmp/$n)" = "$(shasum -a 256 < $OUT/release/$n)" ] && echo "SAME $n" || echo "DIFF $n"; done
```

- [ ] 旧版客户端「检查更新」能看到新版本（清单未上线前会报「更新失败」，属正常）

### 本地兜底（工作流未开出 PR 时）

```bash
cd $OUT/release && gh release download $TAG -R $REPO -p '*.tar.gz' -p '*.sig' --clobber && cd -
node -e '
const fs=require("fs");const [d,base,v]=process.argv.slice(1);
const map={"darwin-aarch64":`Juejin.Usage-${v}-arm64-mac.app.tar.gz`,"darwin-x86_64":`Juejin.Usage-${v}-mac.app.tar.gz`,"windows-x86_64":`Juejin.Usage.Setup.${v}.exe`};
const platforms={};for(const [k,n] of Object.entries(map))platforms[k]={signature:fs.readFileSync(`${d}/${n}.sig`,"utf8").trim(),url:`${base}/${n}`};
fs.writeFileSync("releases/tauri/latest.json",JSON.stringify({version:v,pub_date:new Date().toISOString(),platforms},null,2)+"\n");
' $OUT/release https://gitee.com/$REPO/releases/download/$TAG $VERSION
git add releases/tauri/latest.json
git commit -m "chore(release): point tauri stable feed $VERSION"
git push
```

---

## 8. 打开 Electron → Tauri 迁移开关

计算 sha512（base64）：

```bash
cd $OUT/release
for f in Juejin.Usage-1.0.0-arm64.dmg Juejin.Usage-1.0.0.dmg Juejin.Usage.Setup.1.0.0.exe; do
  echo "$f  $(openssl dgst -sha512 -binary "$f" | base64)"
done
cd -
```

先 dry-run 检查输出：

```bash
BASE=https://gitee.com/$REPO/releases/download/$TAG
node apps/desktop/scripts/enable-tauri-migration.mjs \
  --version $VERSION \
  --arm64-dmg  $BASE/Juejin.Usage-1.0.0-arm64.dmg  --arm64-sha512 '<arm64 sha512>' \
  --intel-dmg  $BASE/Juejin.Usage-1.0.0.dmg        --intel-sha512 '<intel sha512>' \
  --win-exe    $BASE/Juejin.Usage.Setup.1.0.0.exe  --win-sha512   '<win sha512>' \
  --dry-run
```

- [ ] 三个 URL 与 sha512 正确

去掉 `--dry-run` 再执行一次，写入 `releases/electron-to-tauri.json`，然后：

```bash
git add releases/electron-to-tauri.json
git commit -m "chore(release): enable electron to tauri migration"
git push
```

- [ ] Gitee 仓库点「同步」后，raw 上 `releases/electron-to-tauri.json` 已是 `enabled: true`

---

## 9. 验收迁移

在装有 Electron 0.1.16 的 mac 和 Windows 上：

- [ ] 重启应用（或点工具栏检查更新），进度条走完后按钮显示「升级到新版客户端」
- [ ] 点击后应用退出并打开安装包
- [ ] mac 拖入替换 / Windows 走完向导后，打开的是 Tauri 1.0.0，数据和登录态都在
- [ ] 日志 `~/.ai-usage/logs/` 无迁移报错

**回滚**：把 `releases/electron-to-tauri.json` 的 `enabled` 改为 `false` 并推送。Electron 客户端下次检查更新时即恢复走普通更新。

---

## 10. 收尾

迁移稳定一到两周后：

- [ ] GitHub `v1.0.0` 设为 Latest：`gh release edit $TAG -R $REPO --latest`
- [ ] 停止发布 Electron 新版本；Gitee `releases/*.yml` 保持指向 0.1.16
- [ ] 之后的 Tauri 版本：跑第 4～7 步（版本号换成新的），不需要再动迁移开关
