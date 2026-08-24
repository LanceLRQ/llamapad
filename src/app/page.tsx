import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ThemeToggle } from "@/components/theme-toggle";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col bg-background font-sans text-foreground">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <h1 className="text-lg font-semibold tracking-tight">llamapad</h1>
        <ThemeToggle />
      </header>

      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-6 py-10">
        <p className="text-sm text-muted-foreground">
          设计令牌验证页：切换右上角按钮可在 light / dark / system
          三种主题间循环切换，检查下方卡片在双主题下的配色是否正确。
        </p>

        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>按钮 Button</CardTitle>
              <CardDescription>default / secondary / outline / ghost 变体</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-3">
              <Button>主要操作</Button>
              <Button variant="secondary">次要操作</Button>
              <Button variant="outline">描边按钮</Button>
              <Button variant="ghost">幽灵按钮</Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>徽标 Badge</CardTitle>
              <CardDescription>default / secondary / outline 变体</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-3">
              <Badge>默认</Badge>
              <Badge variant="secondary">次要</Badge>
              <Badge variant="outline">描边</Badge>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>状态色</CardTitle>
              <CardDescription>accent-green / accent-red 自定义令牌</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-3">
              <span className="inline-flex h-5 items-center rounded-full bg-accent-green/10 px-2 text-xs font-medium text-accent-green">
                运行中
              </span>
              <span className="inline-flex h-5 items-center rounded-full bg-accent-red/10 px-2 text-xs font-medium text-accent-red">
                已停止
              </span>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>文本层级</CardTitle>
              <CardDescription>foreground 与 muted-foreground</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <p className="text-sm font-medium text-foreground">常规文本（foreground）</p>
              <p className="text-sm text-muted-foreground">
                弱化文本（muted-foreground）：用于说明性、次要信息。
              </p>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
