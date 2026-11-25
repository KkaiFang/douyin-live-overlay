# 抖音直播间礼物墙（douyin-live-overlay）

把直播间送礼事件渲染成「3D 打印机逐层打印奖牌」的动画，供 OBS 浏览器源使用。
详细用法见 `README.md`，这里只记关键约束。

## 运行

```bash
npm install && npx playwright install chromium   # 首次
npm run login    # 一次性扫码登录，不登录收不到礼物消息
npm start        # http://localhost:8181/
```

OBS 源：`/studio`（3D 打印现场）、`/stats`（规则+实时队列），两者都可锁横竖屏。

## 结构

- `lib/grabber.js` — Playwright 抓直播间
- `lib/douyin-events.js` + `lib/proto.js` — 事件 WebSocket 解析（protobuf）
- `lib/server.js` — HTTP/WS 服务
- `public/` — `console.html`(控制台) `studio.html`(3D) `stats.html`(队列) `overlay.html`
- `scripts/probe-ws2.js` — 调试用，探 WS 帧

## 约束

- 只保留事件 WebSocket，**不下载直播视频**（省流量是设计目标）
- 语音播报用浏览器 Web Speech API，不依赖服务端
- 项目已托管在 GitHub（`KkaiFang/douyin-live-overlay`），提交前注意 `.gitignore` 已排除 `.profile/`（登录 Cookie）、`.voice/`、`node_modules/`
- 采集依赖已登录的 Playwright 浏览器上下文，`npm run login` 过期后要重扫

## 协作偏好

- 省 token：先 `rg` 定位再按 `offset` 读，不要整读大文件；调试日志只贴关键段
- 截图会长期占用上下文，尽量用文字描述报错
