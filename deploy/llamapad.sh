#!/usr/bin/env bash
# shellcheck disable=SC2034  # 常量、选项与向导变量跨分区或经 bash 动态作用域使用，逐个标注噪音过大
# llamapad 部署管理脚本：安装、初始化、启停、配置、升级、自检、卸载（单文件，bash 3.2+）
#
# 安装：curl -fsSL https://raw.githubusercontent.com/LanceLRQ/llamapad/main/deploy/llamapad.sh | bash
# 管理：llamapad [命令] [--dir 目录] [--lang zh|en]
#
# LLAMAPAD_SOURCE_ONLY=1 时只定义函数、不执行 main（供测试 source）。

# 以 sh 调用时改用 bash 重新执行。这几行必须保持 POSIX sh 兼容
if [ -z "${BASH_VERSION:-}" ]; then
  if [ -f "$0" ] && command -v bash >/dev/null 2>&1; then exec bash "$0" "$@"; fi
  echo "llamapad.sh requires bash / 需要用 bash 运行" >&2
  exit 1
fi

# ===== 1. 常量与可覆盖路径 =====

LLAMAPAD_SCRIPT_VERSION="0.1.0"
LLAMAPAD_TEMPLATE_VERSION=1
LLAMAPAD_IMAGE="lancelrq/llamapad"
LLAMAPAD_CONTAINER="llamapad"
LLAMAPAD_DEFAULT_HOME="/opt/llamapad"
LLAMAPAD_DEFAULT_PORT=28960
LLAMAPAD_MIN_FREE_KB=$((100 * 1024 * 1024))

# 以下路径与命令均可被环境变量覆盖：测试注入桩，或特殊环境（镜像加速、非常规安装位置）
LP_BIN_DIR="${LLAMAPAD_BIN_DIR:-/usr/local/bin}"
LP_DOCKER="${LLAMAPAD_DOCKER_BIN:-docker}"
LP_SUDO="${LLAMAPAD_SUDO:-sudo}"
LP_NVIDIA_SMI="${LLAMAPAD_NVIDIA_SMI:-nvidia-smi}"
LP_DOCKER_SOCK="${LLAMAPAD_DOCKER_SOCK:-/var/run/docker.sock}"
LP_SYSFS="${LLAMAPAD_SYSFS:-/sys}"
LP_PROC="${LLAMAPAD_PROC:-/proc}"
LP_ETC="${LLAMAPAD_ETC:-/etc}"
LP_TTY="${LLAMAPAD_TTY:-/dev/tty}"
LP_RAW_BASE="${LLAMAPAD_RAW_BASE:-https://raw.githubusercontent.com/LanceLRQ/llamapad}"
LP_HUB_TAGS_URL="${LLAMAPAD_HUB_TAGS_URL:-https://hub.docker.com/v2/repositories/lancelrq/llamapad/tags?page_size=100}"

# 脚本自身路径：curl | bash 时为空（读不到自身文件，安装时改为按版本重新下载）
LP_SELF="${BASH_SOURCE[0]:-}"

LP_LANG=en
LP_HOME=""
OPT_DIR=""
OPT_LANG=""
OPT_TO=""
OPT_FOLLOW=0
CMD=""

# ===== 2. i18n =====
# 文案表：MSG_<zh|en>_<key>，值是 printf 格式串。两种语言的键集合必须一致（测试守护）

MSG_zh_usage='用法：llamapad [命令] [选项]'
MSG_en_usage='Usage: llamapad [command] [options]'
MSG_zh_help_commands_title='命令：'
MSG_en_help_commands_title='Commands:'
MSG_zh_help_options_title='选项：'
MSG_en_help_options_title='Options:'
MSG_zh_help_install='安装并初始化（未安装时直接运行脚本即进入）'
MSG_en_help_install='Install and initialize (default when not installed yet)'
MSG_zh_help_start='启动面板'
MSG_en_help_start='Start the panel'
MSG_zh_help_stop='停止面板'
MSG_en_help_stop='Stop the panel'
MSG_zh_help_restart='重建并重启面板（配置变更后用它生效）'
MSG_en_help_restart='Recreate and restart the panel (applies config changes)'
MSG_zh_help_status='查看运行状态'
MSG_en_help_status='Show status'
MSG_zh_help_logs='查看面板日志（-f 持续跟随）'
MSG_en_help_logs='Show panel logs (-f to follow)'
MSG_zh_help_config='修改配置'
MSG_en_help_config='Change configuration'
MSG_zh_help_upgrade='升级脚本与镜像（--to 指定版本）'
MSG_en_help_upgrade='Upgrade the script and image (--to for a specific version)'
MSG_zh_help_doctor='环境自检'
MSG_en_help_doctor='Check the environment'
MSG_zh_help_uninstall='卸载'
MSG_en_help_uninstall='Uninstall'
MSG_zh_help_help='显示本帮助'
MSG_en_help_help='Show this help'
MSG_zh_help_version='显示脚本版本'
MSG_en_help_version='Show the script version'
MSG_zh_help_opt_dir='指定部署目录'
MSG_en_help_opt_dir='Deployment directory'
MSG_zh_help_opt_lang='界面语言'
MSG_en_help_opt_lang='Interface language'
MSG_zh_help_opt_to='upgrade 的目标版本'
MSG_en_help_opt_to='Target version for upgrade'
MSG_zh_help_opt_follow='logs 持续跟随输出'
MSG_en_help_opt_follow='Follow output for logs'
MSG_zh_unknown_option='未知选项：%s'
MSG_en_unknown_option='Unknown option: %s'
MSG_zh_extra_argument='多余的参数：%s'
MSG_en_extra_argument='Unexpected argument: %s'

# t <key> [参数...]：按当前语言输出文案；键未定义时输出键名本身，便于发现遗漏
t() {
  local name="MSG_${LP_LANG}_$1" fmt
  fmt="${!name}"
  [ -n "$fmt" ] || fmt="$1"
  shift
  # shellcheck disable=SC2059
  printf -- "$fmt" "$@"
}

# 语言判定：--lang > LLAMAPAD_LANG > LC_ALL > LANG；zh 开头为中文，其余英文
detect_lang() {
  local v="${OPT_LANG:-${LLAMAPAD_LANG:-${LC_ALL:-${LANG:-}}}}"
  case "$v" in
    zh*) LP_LANG=zh ;;
    *) LP_LANG=en ;;
  esac
}

# ===== 3. 输出与通用工具 =====

# 颜色只在 stderr 是终端且未设 NO_COLOR 时启用
lp_color_on() { [ -z "${NO_COLOR:-}" ] && [ -t 2 ]; }
lp_sgr() { if lp_color_on; then printf '\033[%sm' "$1"; fi; }

# 提示信息一律写 stderr：stdout 留给可被 $(...) 捕获的函数返回值
info() { printf '%s\n' "$*" >&2; }
ok() { printf '%s✔%s %s\n' "$(lp_sgr 32)" "$(lp_sgr 0)" "$*" >&2; }
warn() { printf '%s⚠%s %s\n' "$(lp_sgr 33)" "$(lp_sgr 0)" "$*" >&2; }
err() { printf '%s✘%s %s\n' "$(lp_sgr 31)" "$(lp_sgr 0)" "$*" >&2; }

# ===== 4. .env / state / 版本 =====

# ===== 5. 端口与磁盘 =====

# ===== 6. 环境探测 =====

# ===== 7. 终端交互 =====

# ===== 8. 模板与写入 =====

# ===== 9. 安装与向导 =====

# ===== 10. 运维命令 =====

# ===== 11. 接管 =====

# ===== 12. 升级 =====

# ===== 13. 自检与卸载 =====

# ===== 14. 入口 =====

cmd_help() {
  local c
  t usage
  printf '\n\n%s\n' "$(t help_commands_title)"
  for c in install start stop restart status logs config upgrade doctor uninstall help version; do
    printf '  %-10s %s\n' "$c" "$(t "help_$c")"
  done
  printf '\n%s\n' "$(t help_options_title)"
  printf '  %-16s %s\n' \
    "--dir DIR" "$(t help_opt_dir)" \
    "--lang zh|en" "$(t help_opt_lang)" \
    "--to VERSION" "$(t help_opt_to)" \
    "-f, --follow" "$(t help_opt_follow)"
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) OPT_DIR="${2:-}"; shift ;;
      --dir=*) OPT_DIR="${1#--dir=}" ;;
      --lang) OPT_LANG="${2:-}"; shift ;;
      --lang=*) OPT_LANG="${1#--lang=}" ;;
      --to) OPT_TO="${2:-}"; shift ;;
      --to=*) OPT_TO="${1#--to=}" ;;
      -f | --follow) OPT_FOLLOW=1 ;;
      -h | --help) CMD=help ;;
      -*) detect_lang; err "$(t unknown_option "$1")"; return 2 ;;
      *)
        if [ -z "$CMD" ]; then CMD="$1"; else detect_lang; err "$(t extra_argument "$1")"; return 2; fi
        ;;
    esac
    shift
  done
}

main() {
  parse_args "$@" || exit 2
  detect_lang
  case "$CMD" in
    help) cmd_help ;;
    version) printf '%s\n' "$LLAMAPAD_SCRIPT_VERSION" ;;
    *) cmd_help; exit 2 ;;
  esac
}

if [ "${LLAMAPAD_SOURCE_ONLY:-}" != "1" ]; then
  main "$@"
fi
