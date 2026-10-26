# 联机服务器（`server/`）

贵州麻将的联机服务端：**权威端（authoritative server）**。发牌、摸牌、碰杠胡判定、报听、抢杠、
冲幺筒、结算全部在服务器上跑——跑的就是单机同一份 `src/js/rules.js` + `src/js/game.js`，
客户端只是「远程的键盘和显示器」，因此联机与单机的规则口径天然一致。

```
┌────────────┐  WebSocket（JSON 消息）  ┌──────────────────────────────┐
│  客户端 A   │ ◄──────────────────────► │  server/index.js             │
│ (Electron/  │   snapshot（按座位轮转）   │   ├─ 房间表 rooms / 玩家表    │
│  浏览器)    │   action（出牌/碰杠胡…）   │   ├─ Room（座位/机器人/配置）  │
└────────────┘                          │   ├─ OnlineGame（对局状态机）  │
                                        │   └─ serialize（快照下发）    │
┌────────────┐                          └──────────────────────────────┘
│  客户端 B…  │ ◄──────────────────────────► 复用 src/js/{rules,ai,game}.js
└────────────┘
```

## 启动

```bash
npm run server                 # 等价于 node server/index.js
node server/index.js --port=8788 --host=0.0.0.0
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--port` | `8788` | 监听端口 |
| `--host` | `0.0.0.0` | 监听网卡；只本机玩可改 `127.0.0.1` |

启动后会把可用地址都打出来：

```
贵州麻将联机服务器已启动
  本机:   ws://127.0.0.1:8788
  局域网: ws://192.168.100.179:8788
  浏览器: http://<上面的地址>/  （同端口，打开即是游戏页面）
```

**同一个端口同时是 HTTP 静态页**：直接 `http://IP:8788` 打开就是游戏（服务 `src/` 目录），
WebSocket 走同端口的 Upgrade。朋友不装任何东西，浏览器就能进房。

依赖只有一个：`ws`（`npm install` 时已装上）。

## 文件职责

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `index.js` | — | HTTP + WS 入口；会话恢复、心跳、房间表、消息校验。导出 `createMahjongServer()` 供测试使用，直接运行时监听端口。 |
| `room.js` | — | 座位、配置、局数限制、掉线保留与房主转移、快照广播和 fx 队列。 |
| `online-game.js` | — | 按座位等待输入、多人抢牌、超时/掉线代打、操作与提示身份校验。 |
| `serialize.js` | — | 隐藏其他玩家手牌和暗杠，按接收者视角旋转牌桌、结算和座位引用。 |

## 协议

全部为 JSON 文本帧。上行 `t` 是消息类型，下行同理；服务端拒绝时回 `{t:"error", err:"原因"}`，
不会中断连接。

### 上行（客户端 → 服务端）

| t | 载荷 | 说明 |
| --- | --- | --- |
| `hello` | `{name}` | 报昵称（≤10 字），进房前随时可改 |
| `resume` | `{token}` | 使用 `welcome.resumeToken` 恢复原会话；掉线后保留 60 秒。凭据仅保存在同一标签页的 sessionStorage，按服务器地址隔离。 |
| `create` | `{config:{mode, totalRounds}}` | 建房，创建者即房主、坐 0 号位；`mode` 取 `rules.js` 的 `MODES` 键（`classic` / `yitong`） |
| `join` | `{room:"4321"}` | 用房号进房，坐第一个空位 |
| `addbot` | — | 房主：往空位补一个机器人（名字取自内部池，不与在场重复） |
| `removebot` | `{uid}` | 房主：移除机器人（对局中禁止） |
| `config` | `{config:{mode,totalRounds}}` | 房主：改玩法/局数（对局中禁止；局数 1–64） |
| `start` | — | 房主：开局。要求 4 座位全满（真人或机器人） |
| `next` | — | 房主：开下一局（本局已结束、未到约定局数） |
| `action` | `{action:{...}}` | 对局内操作，见下表 |
| `leave` | — | 主动退房 |
| `ping` | — | 心跳（客户端每 25s 发一次），回 `pong` |
| `sync` | — | 补发当前房间与本人对局快照，不消费待广播的 fx。 |

`action.type` 取值（服务端会做完整校验，非法操作一律拒绝）：

| type | 载荷 | 时机 |
| --- | --- | --- |
| `discard` | `{tile}` | 等你出牌时；`tile` 必须在你手里（报听锁牌时被拒） |
| `hu` | — | 等你出牌且能自摸时 |
| `gang` | `{gangType:'angang'\|'bugang', tile}` | 等你出牌时；只接受 `selfActions` 给出的那张 |
| `ting` | — | 等你出牌且听牌时；服务端替你打出保持听牌的那张并锁牌 |
| `claim` | `{act:'hu'\|'peng'\|'gang'}` | 别人打出牌 / 补杠时的抢牌提示 |
| `pass` | — | 放弃抢牌 |

### 下行（服务端 → 客户端）

| t | 载荷 | 说明 |
| --- | --- | --- |
| `welcome` | `{uid, online,resumeToken}` | 新连接的临时会话；有旧凭据时先 `resume`，恢复完成后再进行房间操作。 |
| `resumed` | `{uid,resumeToken}` | 已恢复旧会话；有房间时接着发送 `joined`、房间和快照。旧连接被替换并关闭。 |
| `resume-failed` | `{uid,resumeToken}` | 旧会话已失效，使用这条消息给出的新会话。 |
| `hello-ok` | `{name}` | 昵称已生效 |
| `joined` | `{room}` | 进房确认（载荷同 `room`） |
| `room` | `{room}` | 房间状态：房号、座位表（名字/机器人/房主/你是否该座）、配置、是否满员/对局中、累计分 |
| `snapshot` | `{snap, fx}` | 对局快照 + 自上次快照以来的特效，见下 |
| `error` | `{err}` | 上一步被拒的原因（例如「只有房主能开局」「手里没有这张牌」） |
| `left` | — | 退房确认 |
| `pong` | — | 心跳应答 |

### `snap` 快照（按座位轮转后的对局视图）

```
snap = {
  roomId, roundId,                    // 唯一 roundId 用于结算及本地战绩去重
  phase, mode, roundNo, totalRounds, dealer, turn, wallLeft,
  scores[4], roundDeltas[4],          // 已按视角轮转：scores[0] 永远是你
  lastDiscard, discardSeq, discardHot, chongCount, firstChicken,
  players[4]: {                       // players[0] 就是你
    id, name, isHuman, isBot,
    hand: [...], handCount,           // hand 只有你有，别人是 []
    melds: [{type, tile, from, tiles}], // 暗杠只有杠家看得到牌面，别人 tiles=[]
    discards, said, tingDeclared, tianTing, justDrawn
  },
  awaiting,                           // 你的待办提示（没有则 null），见下
  result                              // 一局结束时的结算数据（无则 null）
}
```

`awaiting`（要你操作了）：

```
{ id, kind:'discard', self:{hu, angang[], bugang[]} }  // 操作携带 promptId=id，防止旧提示操作落入新回合
{ kind:'claim', options:['hu','peng','gang'], tile, from, info, rob }  // 抢牌（rob=true 是抢杠）
{ kind:'discard', auto:true, autoTile, ting }          // 报听锁牌后的自动摸打（仅展示）
```

`fx` 是这轮快照附带的动效列表（音效/浮字），服务端已按你的视角轮转座位号：
`discard`、`call`（碰/杠/胡）、`chong`（冲幺筒）、`ting`（报听/天听）、`blocked`（吃炮被拦）、`msg`（旁白）。

## 公平性设计

1. **信息隐藏在服务端**：别人的手牌、暗杠牌面、牌墙顺序永远不会出现在发给你的 JSON 里，
   不是「客户端不去渲染」，而是「根本收不到」。
2. **座位轮转**：快照与 fx 都按观战者旋转（`rotateSeat(seat, forSeat)`），所以客户端 UI 可以
   无差别地把自己当 0 号位——单机渲染代码原样复用。
3. **判定全在服务端**：能碰/能杠/能胡/能不能吃炮（`canChiPao`）、幺筒能不能碰杠、报听锁牌，
   都是服务器算完才告诉你；客户端发来的操作会被重新校验（牌在不在手里、现在能不能胡、
   有没有这个选项）。
4. **对局推进不信任客户端**：摸牌节奏由服务器的 `playLoop` 驱动，客户端只是收到快照后渲染。

## 房间生命周期

```
create ──► 等人(join) ──► addbot 凑满 ──► start ──► 对局(roundNo=1..N) ──► next ──► …
   │            │                             │
   │            └─ leave / 掉线：座位转机器人代打，房主转移给真人
   └─ 全部真人离开（只剩机器人/空位）→ 房间解散（abort + 删除）
```

- **每局之间**：`Room.start()` 会沿用上一局的四家累计分与庄家（`nextDealer`），
  `roundNo` 加一；打到 `config.totalRounds` 后 `next` 会被拒绝。
- **换玩法**：`config` 只能在对局间隙改；改完下一次 `start` 生效。
- **机器人**：开局前或局间可增删；对局进行中禁止新人加入、增删机器人。主动退出的座位由机器人接替，临时掉线的座位则保留给原玩家。
- **局数限制**：`start` 与 `next` 都检查总局数；不能通过重复 `start` 越过约定局数。
- **进房原子性**：加入不存在、满员或进行中的目标房间失败时，保留原房间；重复加入当前房间只补发状态。

## 超时与掉线

| 情形 | 处理 |
| --- | --- |
| 等你出牌 60s 没响应 | 服务端记一条旁白「超时，自动出牌」，按自动摸打策略（能胡就胡，否则打一张保持听牌的牌）替你出 |
| 抢牌提示 20s 没响应 | 视为「过」，不影响别人 |
| 对局中掉线（ws close） | 保留身份和座位 60 秒，`isHuman=false` 临时代打，未决提示立即清算；报听锁牌继续生效 |
| 在宽限期内 `resume` | 同一座位恢复真人控制并补发完整可见状态；未执行的电脑出牌交回真人 |
| 超过宽限期未恢复 | 座位转机器人，清理会话；无真人时终止对局并解散 |
| 房主掉线 | 房主转移给第一个真人类座位 |
| 全部真人离开 | 房间 `abort()` 并从房间表删除，机器人和对局一并销毁 |

超时值可在 `OnlineGame` 构造参数里调：`discardTimeout` / `claimTimeout`（毫秒）。

## 对局内协作细节（`online-game.js`）

- 单机的 `Game` 只支持「seat 0 是人类」，联机版覆写了四条路径：
  - `askDiscard`：真人且未报听 → 挂远程提示等待；报听锁牌与机器人仍走原自动/AI 分支；
  - `askClaim`：带座位号的抢牌提示（每人一个 `prompt`，`prompts: Map<seat, prompt>`）；
  - `resolveClaims`：**多人版**——机器人立刻决策，所有真人并行询问（`Promise.all`），
    谁都答「胡」就一炮多响，否则杠 > 碰取优先级最高者；
  - `resolveRobKong`：多人抢杠同理（报听者自动抢、机器人能抢就抢）。
- `finishPrompt(seat, value)` 是提示的唯一出口：清定时器 → 从 `prompts` 删除 → 广播 →
  resolve 对局循环。`dropPrompt`（掉线/abort 兜底）和超时最终都走它。
- 操作入口只有 `remoteAction(seat, action)`，返回 `{ok, err}`，失败不产生任何状态变化。

## 扩展指南

**加一种联机玩法**：只需在 `src/js/rules.js` 的 `MODES` 里加一项（`wild`/`chickens`/`features`），
客户端「创建房间」的下拉框会自动出现新选项——服务端只校验 `R.MODES[cfg.mode]` 存在，
对局逻辑全部由 `game.js` 按 `mode` 分派，`server/` 不需要改。

**调超时 / 出牌速度**：`Room.start()` 里 `speed: 1.1` 控制电脑与演示节奏；
`discardTimeout` / `claimTimeout` 控制真人等待上限。

**换端口 / 只本机**：`node server/index.js --port=9000 --host=127.0.0.1`。

## 测试与自检

```bash
npm test            # 含 test/online.test.cjs 的 4 项联机用例：
                    #   房间（建房/加入/机器人/满员/房主转移）
                    #   快照（人人 0 号位、他人手牌与暗杠不下发）
                    #   联机整局（2 真人 + 2 机器人连打两局，恒零和）
                    #   操作校验（别人的回合/不存在的牌/乱胡全被拒）
npm run e2e         # 协议级端到端：真起一个服务器，WS 客户端建房→加机器人→打满局数
npm run e2e:ui      # UI 级端到端：Electron 真窗口点完一局（含结算面板）
```

`test/online.test.cjs` 直接实例化 `Room` / `OnlineGame`（用假 ws 桩），不经网络，
适合在改动对局逻辑后快速回归；`scripts/e2e*.cjs` 走真实 WebSocket，验证整条链路。

新增 `test/server.test.cjs`（11 项）覆盖真实连接、会话恢复、房间原子性、心跳、HTTP 错误处理和边界操作；
`test/web.test.cjs`（6 项）覆盖横屏计算、全屏失败兜底、结算去重、网络连接隔离与网页脚本消息集成。
`npm run e2e` 在随机空闲端口创建真实 HTTP/WS 服务，两种玩法同时开桌，各打两局，中途恢复掉线座位。
网页脚本测试使用 DOM 桩，不能替代手机真机的视觉与触摸验收。

## 边界与注意事项

- **内存态**：房间、会话、累计分都在内存里，进程重启即清空；支持进程存活期间的临时掉线恢复，不支持重启恢复。
- **单进程**：一个进程跑所有房间（Node 单线程）；几十桌没有问题，但没有多核扩展。
- **无鉴权**：按局域网/熟人局设计；要上公网请自己加 wss（反向代理即可）与访问控制。
- **心跳检测**：每 30 秒发送 WS ping；下一轮仍未收到 WS pong 时终止连接并进入 60 秒恢复宽限期。上行单消息限制 16 KiB。
- **昵称**：最长 10 字，仅用于展示，不唯一。
