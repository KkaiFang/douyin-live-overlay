# 礼物消息与登录态：实测结论

> **状态：已解决。** 登录后礼物消息正常下发，端到端已验证（真实直播间 20 秒收到 12 条礼物）。

## 结论

**未登录（游客态）的抖音网页直播间，礼物消息不会被下发。** 这是平台侧的风控策略，不是解析问题。

## 实测证据

### 现象：什么都收到了，唯独没有礼物

| 直播间 | 观察时长 | 弹幕 | 进场 | 点赞 | 关注 | **礼物** |
|---|---|---|---|---|---|---|
| 933265010091（1 万人在线） | 150s | 554 | 312 | 49 | 37 | **0** |
| 559416238818（2283 人） | 50s | 8 | 52 | — | — | **0** |
| 253047731129（1477 人） | 50s | 8 | 48 | — | — | **0** |
| 214031179942（29 人） | 50s | 1 | 17 | — | — | **0** |

同时扫描页面 DOM，**也没有出现任何“送出/送给主播”的送礼提示**。说明不是我们漏解了某条消息，而是客户端根本没收到。

### 关键反证：榜单证明有人在送礼，但消息就是不来

解析 `WebcastRoomRankMessage` 拿到的送礼榜单：

```
rank=1  score=15  nick=🧊               id=109305930651
rank=2  score=14  nick=滚蛋             id=748144246419917
rank=3  score=13  nick=翻斗花园小美      id=7621480284227470000
```

榜单分数只统计**送礼**（弹幕、进场不计分）。房间里明明有人送了礼，礼物事件流却一条都没有——**礼物消息被服务端按登录态过滤掉了**。

### 与已知事实一致

- [DouyinLiveWebFetcher issue #164「收不到礼物消息临时解决办法」](https://github.com/saermart/DouyinLiveWebFetcher/issues/164)：抖音收紧策略后，只有已登录 Cookie 才能抓取礼物消息
- [DouyinBarrageGrab README](https://github.com/ape-byte/DouyinBarrageGrab)：“只有到达客户端的弹幕数据才能被接收，被抖音服务器过滤的弹幕是抓不到的”——礼物同理
- 论坛反馈一致：不登录只能拿到在线人数、评论；带上 Cookie 后礼物才出现

## 修复方法（已验证有效）

```bash
npm run login
```

弹出窗口后用抖音 App 扫码，登录态保存在 `.profile/` 里长期复用。

### 关键坑：`--enable-automation`

Playwright 启动 Chrome 时默认会加 `--enable-automation`，这是最明显的自动化指纹。
抖音识别到它之后**登录面板根本不弹出**（只触发隐形的 `rmc-nocaptcha` 验证），
表现就是"点登录没反应"，很容易误判成脚本逻辑错误。

修复：

```js
chromium.launchPersistentContext(PROFILE_DIR, {
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--disable-blink-features=AutomationControlled'],
  ...
})
```

`scripts/login.js` 和 `lib/grabber.js` 都已经加上。另外登录入口要用 `www.douyin.com`，
`live.douyin.com` 不弹登录框。

## 登录后的实测结果

登录前（游客态）→ 登录后对比：

| 消息类型 | 登录前 | 登录后 |
|---|---|---|
| 进场 | ✅ | ✅ |
| 弹幕 | ✅ | ✅ |
| 点赞 / 关注 | ✅ | ✅ |
| **礼物** | **❌ 0 条** | **✅ 20 秒 12 条** |

礼物字段实测（`WebcastGiftMessage`）：

| 位置 | 含义 | 备注 |
|---|---|---|
| `.1` | Common | |
| `.2` | 礼物 ID | varint |
| `.5` | 连击数量 | |
| `.7` | **送礼用户** | 不是 field 2 |
| `.15` | **GiftStruct** | 礼物详情 |
| `.15.1` | 礼物图标 UrlList | |
| `.15.2` | 描述文本 | "送出小心心" |
| `.15.5` | 礼物 ID | |
| `.15.12` | 抖币单价 | |

已验证的礼物：`小心心`(463/1币)、`大啤酒`(2002/2币)、`鲜花`(2006/10币)。

---

# 测试方案

## 分层测试

### 1. 登录态测试（决定礼物能不能收到）

```bash
node /tmp/check-login.js
# {"loginBtns":1,"cookies":2463}  ← loginBtns=1 表示未登录
```

登录后 `loginBtns` 应该变成 0。

### 2. 礼物链路验证

**已验证通过。** 登录后 20 秒收到 12 条真实礼物，用户/头像/礼物名/抖币价全部正确：

```bash
ROOM='https://live.douyin.com/933265010091' JSON=1 node scripts/live.js | grep '"type":"gift"'
```

期望看到：

```bash
npm run overlay   # 另开终端
ROOM='https://live.douyin.com/628867104859' JSON=1 npm run live | grep '"type":"gift"'
```

输出示例：

```json
{"type":"gift",
 "user":{"id":"2247876880379485","shortId":"75724503606","nickname":"小小",
         "avatar":"https://p3.douyinpic.com/...jpeg","fanLevel":14},
 "gift":{"id":"463","name":"小心心","desc":"送出小心心","diamond":1,
         "icon":"https://p11-webcast.douyinpic.com/...png"},
 "count":1,"combo":1}
```

如果字段又变成空的，说明抖音改了协议，用 `scripts/dump.js` 重新定位：

```bash
node scripts/dump.js WebcastGiftMessage
```

### 3. 事件完整性测试（当前可测）

| 事件 | 状态 | 验证命令 |
|---|---|---|
| 进场 `enter` | ✅ 已验证 | 已抓到 312 条 |
| 弹幕 `chat` | ✅ 已验证 | 已抓到 554 条 |
| 关注 `follow` | ✅ 已验证 | 已抓到 37 条 |
| 分享 `share` | ✅ 已验证 | 已抓到 1 条 |
| 点赞 `like` | ✅ 已验证 | 已抓到 49 条 |
| 在线人数 `stats` | ✅ 已验证 | — |
| **礼物 `gift`** | ✅ **已验证** | 登录后 20 秒 12 条 |

### 4. 叠加层测试（不依赖登录）

```bash
npm run mock
```

浏览器打开 `http://localhost:8181/`，会看到模拟的进场/弹幕/送礼特效。
也可以直接开 `http://localhost:8181/?demo=1`，不用起服务就能看效果。

OBS 里添加「浏览器源」，URL 填 `http://localhost:8181/`，宽高自定义，勾选「关闭源时关闭页面」。

### 5. 真实链路联调

```bash
npm run login      # 一次性
npm run overlay    # 起采集 + WebSocket 服务
```

OBS 浏览器源指向 `http://localhost:8181/`，用小号进直播间说句话、点个赞，叠加层应该实时出现。

## 注意事项

- **风控**：真实 Cookie 同时监听多个直播间容易触发风控，建议一次只挂一个
- **窗口**：采集用的浏览器窗口别最小化，隐藏标签会被限速
- **协议变更**：抖音协议经常更新，失效是常态。解析层已经隔离在 `lib/douyin-events.js`，坏了只改这一个文件
- **合规**：这是非官方采集方式，抖音官方文档明确写了「不得通过非直播小玩法应用获取直播间互动数据」，自己玩可以，商业化有风险
