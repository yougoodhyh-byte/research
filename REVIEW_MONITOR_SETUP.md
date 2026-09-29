# 外审动态提醒：最后两步

网站代码已经加入：
- 外审稿件“动态监控”开关；
- 首页“外审动态提醒”卡片；
- 提醒可点击 × 擦掉，并同步到云端；
- GitHub Actions 每小时自动检查一次开启监控的公开追踪链接。

## 1. 初始化 Supabase

打开 Supabase -> SQL Editor，新建查询。

把仓库根目录中的 `review_monitor_setup.sql` 全部复制进去并点击 Run。

运行成功后，刷新科研工作台。进入“外审中” -> 编辑某篇稿件，会看到“外审动态监控”开关。

## 2. 给 GitHub Actions 添加两个 Secret

进入 GitHub 仓库：

Settings -> Secrets and variables -> Actions -> New repository secret

分别添加：

### SUPABASE_URL

值填写你的 Supabase Project URL：

`https://icmqnkzbnjokzfxrjhys.supabase.co`

### SUPABASE_SECRET_KEY

在 Supabase：

Settings -> API Keys -> Secret keys

复制 secret key，填入 GitHub Secret。

注意：Secret key 只能放在 GitHub Actions Secrets 中，不要写入 config.js，不要提交到仓库，也不要公开发送。

## 3. 手动测试一次

进入 GitHub 仓库：

Actions -> Review status monitor -> Run workflow

第一次检查只建立“基准状态”，不会弹提醒。

之后追踪页面发生变化，下一次检查时会在科研工作台首页显示提醒。

## 适用范围

最适合：
- 无需登录即可打开的稿件追踪页面；
- 公开的 Elsevier / Publisher tracking 页面；
- 页面中能看到 Under Review、Required Reviews Completed、Decision in Process 等状态。

如果链接必须登录、输入验证码或依赖浏览器 Cookie，GitHub Actions 无法直接读取。这种链接会记录检查失败，但不会误报为状态变化。

GitHub Actions 定时任务设置为每小时检查一次，实际执行时间可能有少量延迟。
