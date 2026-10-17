// 读者对每条内容的三态反馈：牛逼 / 收到 / 无聊。只有接口，没有页面。
import { defineModule } from "@aihot/contracts/modules";

export const module = defineModule({
  name: "mark",
  apiPaths: [/^\/api\/mark(\/|$|\?)/],
});
