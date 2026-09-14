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
MSG_zh_need_root='该操作需要 root 权限，但当前不是 root 且没有可用的 sudo'
MSG_en_need_root='This step needs root, but you are not root and sudo is not available'
MSG_zh_docker_sudo_note='当前用户无权访问 docker.sock（不是 root 也不在 docker 组），接下来的 docker 命令将通过 sudo 执行，可能需要输入密码'
MSG_en_docker_sudo_note='Your user cannot access docker.sock (not root and not in the docker group); docker commands will run through sudo and may ask for your password'
MSG_zh_docker_missing='未找到 docker 命令。请先安装 Docker Engine：https://docs.docker.com/engine/install/'
MSG_en_docker_missing='The docker command was not found. Install Docker Engine first: https://docs.docker.com/engine/install/'
MSG_zh_docker_daemon_down='无法连接 Docker daemon。请确认服务已启动（systemctl start docker）'
MSG_en_docker_daemon_down='Cannot connect to the Docker daemon. Make sure it is running (systemctl start docker)'
MSG_zh_docker_rootless='检测到 rootless Docker，本脚本暂不支持（面板需要挂载 /var/run/docker.sock）'
MSG_en_docker_rootless='Rootless Docker detected, which this script does not support yet (the panel mounts /var/run/docker.sock)'
MSG_zh_docker_no_compose='缺少 docker compose v2 插件：https://docs.docker.com/compose/install/linux/'
MSG_en_docker_no_compose='The docker compose v2 plugin is missing: https://docs.docker.com/compose/install/linux/'
MSG_zh_docker_unknown='Docker 状态未知'
MSG_en_docker_unknown='Docker status unknown'

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

# 单引号转义，结果可安全拼进 sh 命令行
sh_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# 转绝对路径：展开 ~、拼 PWD、去掉 /./ 与末尾斜杠（不解析 .. 与符号链接）
abs_path() {
  local p="$1"
  # shellcheck disable=SC2088  # 下面是 case 模式匹配字面量 "~/"，不是期待展开的命令参数，误报；
  # 指令只能放在完整命令（这里是 case）前，放在单个分支前 ShellCheck 会报语法错误
  case "$p" in
    "~") p="$HOME" ;;
    "~/"*) p="$HOME/${p#\~/}" ;;
  esac
  case "$p" in
    /*) ;;
    *) p="$PWD/$p" ;;
  esac
  while :; do
    case "$p" in
      */./*) p="${p%%/./*}/${p#*/./}" ;;
      *) break ;;
    esac
  done
  case "$p" in */.) p="${p%/.}" ;; esac
  [ "$p" = / ] || p="${p%/}"
  printf '%s' "${p:-/}"
}

# 属主 uid:gid（GNU/busybox 用 -c，BSD 用 -f）
stat_owner() {
  stat -c '%u:%g' "$1" 2>/dev/null || stat -f '%u:%g' "$1" 2>/dev/null
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# 随机字母数字串（默认 20 位）
gen_password() {
  LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c "${1:-20}"
}

# KB → 38G / 1.2T 这种写法：≥10 取整，<10 保留一位小数
fmt_kb() {
  awk -v k="$1" 'BEGIN {
    split("K M G T P", u, " "); v = k + 0; i = 1
    while (v >= 1024 && i < 5) { v /= 1024; i++ }
    if (v >= 10 || i == 1) printf "%d%s", v, u[i]; else printf "%.1f%s", v, u[i]
  }'
}

# ===== 4. .env / state / 版本 =====

# .env 值的写法：只含安全字符时原样写，否则单引号包裹（compose 对单引号值不做 $ 插值）
env_quote() {
  case "$1" in
    *[!A-Za-z0-9_./:@,+%=-]*) printf "'%s'" "$1" ;;
    *) printf '%s' "$1" ;;
  esac
}

# 单引号包裹无法表达值里的单引号与换行，这两种一律拒绝
env_valid_value() {
  case "$1" in
    *"'"* | *$'\n'*) return 1 ;;
  esac
  return 0
}

# env_get FILE KEY：取最后一次出现的值，去掉包裹引号与未加引号值的行尾注释；缺键返回 1
env_get() {
  local line v
  [ -f "$1" ] || return 1
  line=$(grep "^$2=" "$1" | tail -n 1)
  [ -n "$line" ] || return 1
  v="${line#*=}"
  # 整段值首尾都是同一种引号时，原样剥掉首尾各一个字符——保留内部可能出现的同类引号
  # （比如存 JSON 字符串时转义写出的 \"），不能用「找最靠左引号」的办法，否则会在内部截断。
  # 引号开头但不是这种首尾对称收尾（闭合引号后还跟了空白与行尾注释）时，才退化为剥到
  # 最靠左的同类引号为止；这两类分支必须放在这个先后顺序，前者更精确、要优先匹配
  case "$v" in
    \'*\') v="${v#\'}"; v="${v%\'}" ;;
    \"*\") v="${v#\"}"; v="${v%\"}" ;;
    \'*) v="${v#\'}"; v="${v%%\'*}" ;;
    \"*) v="${v#\"}"; v="${v%%\"*}" ;;
    *) v="${v%% #*}" ;;
  esac
  printf '%s\n' "$v"
}

# env_set FILE KEY VALUE：原地替换首个同名行并删去其余同名行；缺失则追加。
# 不重排、不动注释与其他变量；写回用 cat > 保留原文件权限与属主
env_set() {
  local f="$1" k="$2" v="$3" line tmp
  env_valid_value "$v" || return 2
  line="$k=$(env_quote "$v")"
  tmp="$f.tmp.$$"
  if [ -f "$f" ] && grep -q "^$k=" "$f"; then
    LP_LINE="$line" awk -v k="$k=" '
      index($0, k) == 1 { if (!done) { print ENVIRON["LP_LINE"]; done = 1 } next }
      { print }' "$f" >"$tmp" || { rm -f "$tmp"; return 1; }
  else
    {
      if [ -f "$f" ]; then
        cat "$f"
        [ -z "$(tail -c 1 "$f")" ] || printf '\n'
      fi
      printf '%s\n' "$line"
    } >"$tmp" || { rm -f "$tmp"; return 1; }
  fi
  if [ -f "$f" ]; then
    cat "$tmp" >"$f" && rm -f "$tmp"
  else
    mv "$tmp" "$f"
  fi
}

state_file() { printf '%s/.llamapad-state' "$LP_HOME"; }
state_get() { env_get "$(state_file)" "$1"; }
state_set() { env_set "$(state_file)" "$1" "$2"; }

_num_cmp() {
  if [ "$1" -gt "$2" ]; then echo 1; elif [ "$1" -lt "$2" ]; then echo -1; else echo 0; fi
}

# ver_cmp A B → 1 / 0 / -1。X.Y.Z 逐段数值比较；主体相同时预发布低于正式版，预发布之间按字典序
ver_cmp() {
  local a="${1#v}" b="${2#v}" ap="" bp="" r
  local a1 a2 a3 b1 b2 b3
  case "$a" in *-*) ap="${a#*-}"; a="${a%%-*}" ;; esac
  case "$b" in *-*) bp="${b#*-}"; b="${b%%-*}" ;; esac
  # 逐段剥离：缺段（如 "0.1"）时剩余段为空，下面统一补 0
  a1="${a%%.*}"; a="${a#"$a1"}"; a="${a#.}"; a2="${a%%.*}"; a="${a#"$a2"}"; a="${a#.}"; a3="${a%%.*}"
  b1="${b%%.*}"; b="${b#"$b1"}"; b="${b#.}"; b2="${b%%.*}"; b="${b#"$b2"}"; b="${b#.}"; b3="${b%%.*}"
  for r in a1 a2 a3 b1 b2 b3; do
    eval "$r=\${$r%%[!0-9]*}; $r=\${$r:-0}"
  done
  r=$(_num_cmp "$a1" "$b1"); [ "$r" = 0 ] || { echo "$r"; return; }
  r=$(_num_cmp "$a2" "$b2"); [ "$r" = 0 ] || { echo "$r"; return; }
  r=$(_num_cmp "$a3" "$b3"); [ "$r" = 0 ] || { echo "$r"; return; }
  if [ "$ap" = "$bp" ]; then
    echo 0
  elif [ -z "$ap" ]; then
    echo 1
  elif [ -z "$bp" ]; then
    echo -1
  elif [ "$(printf '%s\n%s\n' "$ap" "$bp" | sort | head -n 1)" = "$ap" ]; then
    echo -1
  else
    echo 1
  fi
}

# stdin 每行一个版本 → 输出最大的正式版（X.Y.Z）；一个都没有返回 1
ver_latest_stable() {
  local best="" v
  while IFS= read -r v; do
    v="${v#v}"
    printf '%s' "$v" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || continue
    if [ -z "$best" ] || [ "$(ver_cmp "$v" "$best")" = 1 ]; then best="$v"; fi
  done
  [ -n "$best" ] || return 1
  printf '%s\n' "$best"
}

# Docker Hub tags API 的 JSON（stdin）→ 每行一个 tag 名
hub_tags_parse() {
  grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/'
}

# ===== 5. 端口与磁盘 =====

# ss -tln / netstat -tln 的输出（stdin）里是否有该端口在监听：两者第 4 列都是「本地地址:端口」
listen_table_has_port() {
  awk -v p="$1" '{ n = split($4, a, ":"); if (a[n] == p) f = 1 } END { exit !f }'
}

# proc_tcp_has_port PORT FILE...：/proc/net/tcp{,6} 第 2 列本地地址末尾是 :十六进制端口，第 4 列 0A 为 LISTEN
proc_tcp_has_port() {
  local hex f
  hex=$(printf '%04X' "$1")
  shift
  for f in "$@"; do
    [ -r "$f" ] || continue
    awk -v h=":$hex" 'NR > 1 && $4 == "0A" && substr($2, length($2) - 4) == h { f = 1 } END { exit !f }' "$f" && return 0
  done
  return 1
}

port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    ss -tln 2>/dev/null | listen_table_has_port "$1"
    return
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -tln 2>/dev/null | listen_table_has_port "$1"
    return
  fi
  proc_tcp_has_port "$1" "$LP_PROC/net/tcp" "$LP_PROC/net/tcp6"
}

# /proc/mounts 里空格等字符写作 \040 这类八进制转义
mount_unescape() {
  printf '%b' "$(printf '%s' "$1" | sed 's/\\\([0-7][0-7][0-7]\)/\\0\1/g')"
}

# stdin 为 /proc/mounts → 输出「设备<TAB>挂载点<TAB>文件系统」。
# 过滤伪文件系统、系统目录与容器运行时目录；同一设备多处挂载（bind）只留最短的挂载点
mounts_usable() {
  awk '
    BEGIN {
      n = split("tmpfs devtmpfs overlay squashfs proc sysfs cgroup cgroup2 devpts mqueue securityfs debugfs tracefs pstore bpf autofs hugetlbfs configfs fusectl rpc_pipefs nsfs efivarfs binfmt_misc ramfs fuse.lxcfs nfsd", x, " ")
      for (i = 1; i <= n; i++) skip[x[i]] = 1
    }
    skip[$3] { next }
    $2 ~ /^\/(boot|proc|sys|dev|run|snap)(\/|$)/ { next }
    $2 ~ /^\/var\/lib\/(docker|containerd|kubelet)(\/|$)/ { next }
    { if (!($1 in best) || length($2) < length(best[$1])) { best[$1] = $2; fs[$1] = $3 } }
    END { for (d in best) printf "%s\t%s\t%s\n", d, best[d], fs[d] }'
}

# nvme0n1p2→nvme0n1、mmcblk0p1→mmcblk0、sda3→sda。
# 这一支要求「数字+p+数字」结尾才算分区后缀：loop0 本身以 p 收尾的假分区不能被误剥成 loo
disk_strip_part() {
  case "$1" in
    nvme* | mmcblk* | loop*) printf '%s' "$1" | sed -E 's/([0-9])p[0-9]+$/\1/' ;;
    *) printf '%s' "$1" | sed -E 's/[0-9]+$//' ;;
  esac
}

# 块设备名 → nvme / ssd / hdd / mixed / unknown。
# 虚拟盘（vd*、xvd*）的 rotational 常误报为 1，宁可 unknown 也不标 HDD 误导用户
disk_type_of_block() {
  local name="$1" base s t types=""
  case "$name" in
    dm-* | md*)
      [ -d "$LP_SYSFS/block/$name/slaves" ] || { printf unknown; return; }
      for s in "$LP_SYSFS/block/$name/slaves"/*; do
        [ -e "$s" ] || [ -L "$s" ] || continue
        t=$(disk_type_of_block "$(basename "$s")")
        case " $types " in
          *" $t "*) ;;
          *) types="$types $t" ;;
        esac
      done
      types="${types# }"
      case "$types" in
        "") printf unknown ;;
        *" "*) printf mixed ;;
        *) printf '%s' "$types" ;;
      esac
      return
      ;;
  esac
  base="$name"
  [ -d "$LP_SYSFS/block/$base" ] || base=$(disk_strip_part "$name")
  case "$base" in
    nvme*) printf nvme ;;
    vd* | xvd*) printf unknown ;;
    *)
      case "$(cat "$LP_SYSFS/block/$base/queue/rotational" 2>/dev/null)" in
        1) printf hdd ;;
        0) printf ssd ;;
        *) printf unknown ;;
      esac
      ;;
  esac
}

# disk_type 设备 文件系统 → nvme / ssd / hdd / mixed / network / unknown
disk_type() {
  local dev="$1" fs="$2" d
  case "$fs" in
    nfs* | cifs | smb* | fuse.sshfs | glusterfs | ceph) printf network; return ;;
  esac
  case "$dev" in
    /dev/mapper/*)
      for d in "$LP_SYSFS"/block/dm-*; do
        if [ "$(cat "$d/dm/name" 2>/dev/null)" = "${dev#/dev/mapper/}" ]; then
          disk_type_of_block "$(basename "$d")"
          return
        fi
      done
      printf unknown
      ;;
    /dev/*) disk_type_of_block "${dev#/dev/}" ;;
    *) printf unknown ;;
  esac
}

# 路径不存在时向上找到第一个已存在的祖先（df 只能查存在的路径）
path_existing_parent() {
  local p="$1"
  while [ ! -e "$p" ] && [ "$p" != / ]; do p=$(dirname "$p"); done
  printf '%s' "$p"
}

df_avail_kb() {
  df -Pk "$1" 2>/dev/null | awk 'NR == 2 { print $4; f = 1 } END { exit !f }'
}

# 挂载点在第 6 列之后（含空格的挂载点会被 awk 拆开，这里把第 6 列起的内容拼回）
df_mount() {
  df -Pk "$1" 2>/dev/null | awk 'NR == 2 { $1 = $2 = $3 = $4 = $5 = ""; sub(/^ +/, ""); print }'
}

# disk_candidates 默认路径 → TSV「路径<TAB>盘类型<TAB>剩余KB<TAB>是否系统盘」。
# 首行是默认位置（类型取其所在挂载点），其余每个可用挂载点给出 <挂载点>/llamapad/models，按剩余空间降序
disk_candidates() {
  local def="$1" defparent defmount deftype=unknown tab dev mnt fs avail rows=""
  tab=$(printf '\t')
  defparent=$(path_existing_parent "$def")
  defmount=$(df_mount "$defparent")
  while IFS="$tab" read -r dev mnt fs; do
    [ -n "$dev" ] || continue
    mnt=$(mount_unescape "$mnt")
    if [ "$mnt" = "$defmount" ]; then
      deftype=$(disk_type "$dev" "$fs")
      continue
    fi
    avail=$(df_avail_kb "$mnt") || continue
    rows="$rows${mnt%/}/llamapad/models$tab$(disk_type "$dev" "$fs")$tab$avail${tab}0
"
  done <<EOF
$(mounts_usable <"$LP_PROC/mounts")
EOF
  printf '%s\t%s\t%s\t%s\n' "$def" "$deftype" "$(df_avail_kb "$defparent")" "$([ "$defmount" = / ] && echo 1 || echo 0)"
  printf '%s' "$rows" | sort -t "$tab" -k3,3nr
}

# ===== 6. 环境探测 =====

lp_is_root() { [ "$(id -u)" = 0 ]; }

# 以 root 身份执行：已是 root 直接跑，否则经 sudo；都不行时报错
as_root() {
  if lp_is_root; then
    "$@"
    return
  fi
  if command -v "$LP_SUDO" >/dev/null 2>&1; then
    "$LP_SUDO" "$@"
    return
  fi
  err "$(t need_root)"
  return 1
}

platform_ok() {
  [ "${LLAMAPAD_SKIP_PLATFORM_CHECK:-}" = 1 ] || [ "$(uname -s)" = Linux ]
}

DK_SUDO=0
DK_STATE=""

# 所有 docker 调用都经它：探测出需要 sudo 时自动加上
dk() {
  if [ "$DK_SUDO" = 1 ]; then
    "$LP_SUDO" "$LP_DOCKER" "$@"
  else
    "$LP_DOCKER" "$@"
  fi
}

# 设置 DK_STATE：ok / missing / daemon_down / rootless / no_compose，非 ok 返回 1
docker_probe() {
  DK_SUDO=0
  if ! command -v "$LP_DOCKER" >/dev/null 2>&1; then
    DK_STATE=missing
    return 1
  fi
  if ! "$LP_DOCKER" info >/dev/null 2>&1; then
    # 连不上有两种可能：没权限访问 sock（非 root 且不在 docker 组），或 daemon 根本没起
    if [ -S "$LP_DOCKER_SOCK" ] && ! lp_is_root &&
      { [ ! -r "$LP_DOCKER_SOCK" ] || [ ! -w "$LP_DOCKER_SOCK" ]; } &&
      command -v "$LP_SUDO" >/dev/null 2>&1; then
      info "$(t docker_sudo_note)"
      DK_SUDO=1
      if ! dk info >/dev/null 2>&1; then
        DK_STATE=daemon_down
        return 1
      fi
    else
      DK_STATE=daemon_down
      return 1
    fi
  fi
  case "$(dk info --format '{{.SecurityOptions}}' 2>/dev/null)" in
    *rootless*) DK_STATE=rootless; return 1 ;;
  esac
  if ! dk compose version >/dev/null 2>&1; then
    DK_STATE=no_compose
    return 1
  fi
  DK_STATE=ok
}

docker_probe_message() {
  case "$DK_STATE" in
    missing) t docker_missing ;;
    daemon_down) t docker_daemon_down ;;
    rootless) t docker_rootless ;;
    no_compose) t docker_no_compose ;;
    *) t docker_unknown ;;
  esac
}

require_docker() {
  docker_probe && return 0
  err "$(docker_probe_message)"
  return 1
}

detect_docker_gid() {
  stat -c %g "$LP_DOCKER_SOCK" 2>/dev/null || stat -f %g "$LP_DOCKER_SOCK" 2>/dev/null
}

# 每行一张卡「GPU N: 型号」；nvidia-smi 不存在或无卡时返回 1
gpu_cards() {
  command -v "$LP_NVIDIA_SMI" >/dev/null 2>&1 || return 1
  "$LP_NVIDIA_SMI" -L 2>/dev/null | grep '^GPU ' | sed -E 's/ \(UUID: [^)]*\)$//'
}

# 容器能否用 GPU：docker 注册了 nvidia 运行时，或 nvidia-container-toolkit 生成了 CDI 规格
gpu_runtime_ok() {
  dk info --format '{{json .Runtimes}}' 2>/dev/null | grep -q nvidia && return 0
  [ -f "$LP_ETC/cdi/nvidia.yaml" ] || [ -f /var/run/cdi/nvidia.yaml ]
}

detect_timezone() {
  local tz="" link
  [ -f "$LP_ETC/timezone" ] && tz=$(head -n 1 "$LP_ETC/timezone")
  [ -n "$tz" ] || tz=$(timedatectl show -p Timezone --value 2>/dev/null)
  if [ -z "$tz" ] && [ -L "$LP_ETC/localtime" ]; then
    link=$(readlink "$LP_ETC/localtime")
    case "$link" in
      *zoneinfo/*) tz="${link##*zoneinfo/}" ;;
    esac
  fi
  printf '%s' "${tz:-UTC}"
}

lan_ips() {
  local ips
  ips=$(hostname -I 2>/dev/null)
  [ -n "$ips" ] || ips=$(ip -4 -o addr show scope global 2>/dev/null | awk '{ sub(/\/.*/, "", $4); print $4 }')
  # shellcheck disable=SC2086
  printf '%s\n' $ips | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -n 3
}

# access_urls 监听地址 端口 → 每行一个可访问地址
access_urls() {
  local ip
  case "$1" in
    "" | 0.0.0.0)
      for ip in $(lan_ips) 127.0.0.1; do printf 'http://%s:%s\n' "$ip" "$2"; done
      ;;
    *) printf 'http://%s:%s\n' "$1" "$2" ;;
  esac
}

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
