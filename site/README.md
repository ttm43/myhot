# 站点

这个站自己的东西：名字、文案、品牌，以及启用哪些模块。步骤见 [把它改成你的行业](../docs/customize.md)。

| 文件 | 内容 |
|---|---|
| `site.ts` | 站名、行业词、首页文案、条目上的说法、公开接口的分类、备案号 |
| `models.ts` | 具名的模型和每一步默认用哪个（没写的步骤用 `.env` 里配的那一个） |
| `brand/` | 图标、Logo（`Logo.tsx`） |
| `public/` | 发布在网站根目录的 PWA 清单 `manifest.webmanifest`（站名、地址等占位符替换后发布） |
| `modules/` | 启用哪些模块：`index.ts`、`server.ts`、`web.ts` 三份清单，列出仓库根目录 `modules/<名字>/` 里要用的模块，默认都为空，见 [架构](../docs/architecture.md#模块) 的“模块” |
