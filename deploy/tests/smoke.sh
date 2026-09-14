#!/usr/bin/env bash
# 多环境冒烟：在没有 node 的容器（bash:3.2 / alpine / rockylinux 等）里验证语法与纯函数
set -e
cd "$(dirname "$0")/.."
bash -n llamapad.sh
# shellcheck disable=SC2034  # 供下面 source 的 llamapad.sh 在同一 shell 内读取，跨文件的动态使用
LLAMAPAD_SOURCE_ONLY=1
# shellcheck disable=SC1091  # 同目录相对路径 source，静态解析路径无意义
. ./llamapad.sh
[ "$(ver_cmp 0.2.0 0.1.9)" = 1 ]
[ "$(ver_cmp 1.0.0-rc.1 1.0.0)" = -1 ]
[ "$(printf '%s\n' latest 0.1.0 0.3.0-rc.1 0.2.0 | ver_latest_stable)" = 0.2.0 ]
[ "$(env_quote 'a b')" = "'a b'" ]
f=$(mktemp)
# shellcheck disable=SC2016  # 单引号是有意为之：验证字面 $y 被原样保留、不被 shell 展开
env_set "$f" K 'x $y'
# shellcheck disable=SC2016  # 同上：断言里的字面 $y 不应被展开
[ "$(env_get "$f" K)" = 'x $y' ]
rm -f "$f"
[ "$(disk_strip_part nvme0n1p2)" = nvme0n1 ]
[ "$(abs_path /a/./b/)" = /a/b ]
[ "$(gen_password 12 | wc -c | tr -d ' ')" = 12 ]
tpl_compose | grep -q 'lancelrq/llamapad'
unset LLAMAPAD_SOURCE_ONLY
bash llamapad.sh help >/dev/null
echo "smoke ok: $(bash --version | head -n 1)"
