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

# 这一行的格式是跨版本接口：self_update 校验下载到的新脚本时按这一整行做精确字符串匹配
# （见 self_update），只能原样保留——不得加尾注释、不得把双引号换成单引号、不得增删空格
LLAMAPAD_SCRIPT_VERSION="0.2.1"
LLAMAPAD_TEMPLATE_VERSION=1
LLAMAPAD_HUB_IMAGE="lancelrq/llamapad"
# 本地构建镜像固定用这个名:tag，不随仓库/机器变化
LLAMAPAD_DEV_IMAGE="llamapad"
LLAMAPAD_DEV_TAG="dev"
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
LP_RUN="${LLAMAPAD_RUN_DIR:-/var/run}"
LP_TTY="${LLAMAPAD_TTY:-/dev/tty}"
# 交互输入源只在这里打开一次，之后所有读都走这个 fd；编号写死是因为 bash 3.2 没有
# `exec {var}<…` 的自动分配。`-` 表示沿用已继承的 stdin（测试用）。打不开就让 fd 空着，
# 交互入口（ui_plain / cmd_install）照常探测得到并给出提示。
#
# 为什么不逐次 `read <"$LP_TTY"` 重开：那在 Linux 上对管道不成立。stdin 是管道时
# /dev/stdin 指向 /proc/self/fd/0 → pipe:[N]，写端一关（Node 的 spawnSync 喂完输入
# 立刻就关）再 open 直接 ENXIO；macOS 的 /dev/stdin 是 fd 0 的克隆设备才看不出问题。
#
# 花括号组包住 exec 才能吞掉 open 失败的报错：重定向按从左到右处理，写成
# `exec 9<… 2>/dev/null` 时 9< 已经失败并打印，2> 再关也来不及
LP_TTY_FD=9
if [ "$LP_TTY" = "-" ]; then
  exec 9<&0
else
  { exec 9<"$LP_TTY"; } 2>/dev/null || true
fi
LP_RAW_BASE="${LLAMAPAD_RAW_BASE:-https://raw.githubusercontent.com/LanceLRQ/llamapad}"
LP_HUB_TAGS_URL="${LLAMAPAD_HUB_TAGS_URL:-https://hub.docker.com/v2/repositories/lancelrq/llamapad/tags?page_size=100}"

# 脚本自身路径：curl | bash 时为空（读不到自身文件，安装时改为按版本重新下载）
LP_SELF="${BASH_SOURCE[0]:-}"

LP_LANG=en
LP_HOME=""
OPT_DIR=""
OPT_LANG=""
OPT_TO=""
OPT_REPO=""
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
MSG_zh_help_opt_dir='指定安装目录'
MSG_en_help_opt_dir='Install directory'
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
MSG_zh_env_header_1='# llamapad 部署配置（由 llamapad.sh 生成）。可以手改：脚本只按键替换，不会删除你的注释与自定义变量'
MSG_en_env_header_1='# llamapad deployment config (generated by llamapad.sh). Safe to edit by hand: the script only replaces keys and keeps your comments and extra variables'
MSG_zh_env_header_2='# 含管理员密码，请勿提交到版本库或外传'
MSG_en_env_header_2='# Contains the admin password; do not commit or share it'
MSG_zh_chown_need_root='需要 root 权限把 %s 的属主改为 %s'
MSG_en_chown_need_root='Root is needed to change the owner of %s to %s'
MSG_zh_mkdir_need_root='需要 root 权限创建目录 %s'
MSG_en_mkdir_need_root='Root is needed to create %s'
MSG_zh_ui_menu_hint='↑↓ 选择   Enter 确认   q 返回'
MSG_en_ui_menu_hint='↑↓ select   Enter confirm   q back'
MSG_zh_ui_number_prompt='请输入序号（q 返回）：'
MSG_en_ui_number_prompt='Enter a number (q to go back): '
MSG_zh_ui_yes='是'
MSG_en_ui_yes='Yes'
MSG_zh_ui_no='否'
MSG_en_ui_no='No'
MSG_zh_ui_press_enter='按 Enter 继续…'
MSG_en_ui_press_enter='Press Enter to continue…'
MSG_zh_unsupported_platform='本脚本只支持 Linux 宿主机'
MSG_en_unsupported_platform='This script only supports Linux hosts'
MSG_zh_no_tty='无法打开终端进行交互。请改为先下载再执行：curl -fsSLO <地址> && bash llamapad.sh'
MSG_en_no_tty='Cannot open a terminal for interaction. Download first, then run: curl -fsSLO <url> && bash llamapad.sh'
MSG_zh_install_welcome='llamapad 部署管理脚本 v%s —— 开始安装'
MSG_en_install_welcome='llamapad deployment script v%s — starting installation'
MSG_zh_ask_install_dir='安装目录'
MSG_en_ask_install_dir='Install directory'
MSG_zh_install_dir_note='安装目录将存放：脚本本体、compose 配置与 .env、面板数据 data/（数据库、YAML 快照、日志与备份）；模型库默认放在其中的 models/ 下，后面可以另选位置'
MSG_en_install_dir_note='The install directory will hold: the script, the compose config and .env, and panel data in data/ (database, YAML snapshots, logs and backups); the model library defaults to models/ inside it, and you can pick another location later'
MSG_zh_install_dir_invalid='目录路径不能包含空格或冒号'
MSG_en_install_dir_invalid='The directory path cannot contain spaces or colons'
MSG_zh_install_dir_forbidden='%s 不能用作安装目录（系统目录或不安全的路径）'
MSG_en_install_dir_forbidden='%s cannot be used as the install directory (a system directory or an unsafe path)'
MSG_zh_dir_not_empty='%s 已存在且不是空目录，以下是部分内容（最多 10 项）：'
MSG_en_dir_not_empty='%s already exists and is not empty (showing up to 10 entries):'
MSG_zh_dir_not_empty_hint='建议改用一个空目录，例如 %s'
MSG_en_dir_not_empty_hint='Consider using an empty directory instead, e.g. %s'
MSG_zh_ask_use_nonempty_dir='仍然安装到这个非空目录？'
MSG_en_ask_use_nonempty_dir='Install into this non-empty directory anyway?'
MSG_zh_already_installed='%s 已经安装过，进入管理菜单'
MSG_en_already_installed='%s is already installed; opening the management menu'
MSG_zh_dir_need_root='没有权限写入 %s，是否用 sudo 创建并把属主改为当前用户？'
MSG_en_dir_need_root='No permission to write %s. Create it with sudo and hand it to the current user?'
MSG_zh_launcher_overwrite='%s 已存在且指向其他安装，是否覆盖？'
MSG_en_launcher_overwrite='%s already exists and points to another installation. Overwrite it?'
MSG_zh_launcher_need_sudo='写入 %s 需要 root 权限，是否使用 sudo？'
MSG_en_launcher_need_sudo='Writing %s needs root. Use sudo?'
MSG_zh_launcher_skipped='已跳过 llamapad 命令，之后请用 %s 管理'
MSG_en_launcher_skipped='Skipped the llamapad command; use %s to manage the panel'
MSG_zh_launcher_done='已安装命令：%s（任意目录执行 llamapad 即可管理）'
MSG_en_launcher_done='Installed command: %s (run llamapad from any directory)'
MSG_zh_self_download_failed='下载脚本失败（可设置 LLAMAPAD_RAW_BASE 指向可访问的镜像地址）'
MSG_en_self_download_failed='Failed to download the script (set LLAMAPAD_RAW_BASE to a reachable mirror)'
MSG_zh_self_syntax_failed='下载的脚本未通过语法检查，已放弃'
MSG_en_self_syntax_failed='The downloaded script failed the syntax check and was discarded'
MSG_zh_unknown_command='未知命令：%s'
MSG_en_unknown_command='Unknown command: %s'
MSG_zh_not_installed='llamapad 尚未安装（或未找到安装目录），请先运行 llamapad.sh 安装，或用 --dir 指定安装目录'
MSG_en_not_installed='llamapad is not installed (or the install directory was not found). Run llamapad.sh to install, or pass --dir'
MSG_zh_wizard_intro='接下来依次确认以下事项，每项都有默认值，直接回车即可采用：
  · 镜像来源 · 模型库位置 · 运行身份 · GPU · 端口与监听地址
  · 管理员密码 · 时区 · 外部 LLM（可选，可跳过）
最后是汇总页，可选中任意一项回头修改；确认之前不会写入任何配置文件'
MSG_en_wizard_intro='Next, confirm the following one by one. Every item has a default; press Enter to accept it:
  · image source · model library location · runtime identity · GPU · port and listen address
  · admin password · timezone · external LLM (optional, can be skipped)
A summary page at the end lets you revisit any item; nothing is written until you confirm'
MSG_zh_ask_models_dir='选择模型库位置（GGUF 文件动辄数十 GB，建议放在大容量数据盘）'
MSG_en_ask_models_dir='Choose the model library location (GGUF files are often tens of GB; prefer a large data disk)'
MSG_zh_disk_manual='手动输入路径…'
MSG_en_disk_manual='Enter a path…'
MSG_zh_disk_free='剩余 %s'
MSG_en_disk_free='%s free'
MSG_zh_disk_system='系统盘'
MSG_en_disk_system='system disk'
MSG_zh_disk_low_space='⚠ 空间偏小'
MSG_en_disk_low_space='⚠ low space'
MSG_zh_disk_network_slow='网络盘，读取模型会慢'
MSG_en_disk_network_slow='network storage, model loading will be slow'
MSG_zh_disk_type_nvme='NVMe'
MSG_en_disk_type_nvme='NVMe'
MSG_zh_disk_type_ssd='SSD'
MSG_en_disk_type_ssd='SSD'
MSG_zh_disk_type_hdd='HDD'
MSG_en_disk_type_hdd='HDD'
MSG_zh_disk_type_mixed='混合'
MSG_en_disk_type_mixed='Mixed'
MSG_zh_disk_type_network='网络'
MSG_en_disk_type_network='Network'
MSG_zh_disk_type_unknown='未知'
MSG_en_disk_type_unknown='Unknown'
MSG_zh_ask_models_path='模型库绝对路径'
MSG_en_ask_models_path='Absolute path of the model library'
MSG_zh_models_path_invalid='请输入绝对路径，且不能包含空格、冒号或引号'
MSG_en_models_path_invalid='Enter an absolute path without spaces, colons or quotes'
MSG_zh_models_found='该目录已有 %s 个 GGUF 文件，共 %s'
MSG_en_models_found='Found %s GGUF files (%s) in this directory'
MSG_zh_ask_identity='面板运行身份（必须对 data/ 与模型库可写）'
MSG_en_ask_identity='Panel runtime identity (must be able to write data/ and the model library)'
MSG_zh_identity_follow='跟随模型库属主 %s（推荐）'
MSG_en_identity_follow='Match the model library owner %s (recommended)'
MSG_zh_identity_new='普通用户 1000:1000（推荐，新建目录会自动对齐属主）'
MSG_en_identity_new='Regular user 1000:1000 (recommended; new directories are chowned automatically)'
MSG_zh_identity_current='当前用户 %s'
MSG_en_identity_current='Current user %s'
MSG_zh_identity_root='root 0:0'
MSG_en_identity_root='root 0:0'
MSG_zh_identity_custom='自定义…'
MSG_en_identity_custom='Custom…'
MSG_zh_ask_uid_gid='UID:GID'
MSG_en_ask_uid_gid='UID:GID'
MSG_zh_uid_gid_invalid='格式应为 数字:数字，例如 1000:1000'
MSG_en_uid_gid_invalid='Use the form number:number, e.g. 1000:1000'
MSG_zh_gpu_none='未检测到 NVIDIA GPU，面板将以无 GPU 方式运行'
MSG_en_gpu_none='No NVIDIA GPU detected; the panel will run without GPU'
MSG_zh_gpu_found='检测到 GPU：'
MSG_en_gpu_found='GPUs detected:'
MSG_zh_ask_gpu_enable='启用 GPU？'
MSG_en_ask_gpu_enable='Enable GPU?'
MSG_zh_gpu_no_toolkit='检测到显卡，但 Docker 没有 NVIDIA 运行时。请先安装 nvidia-container-toolkit：https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html'
MSG_en_gpu_no_toolkit='GPUs found, but Docker has no NVIDIA runtime. Install nvidia-container-toolkit first: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html'
MSG_zh_ask_gpu_enable_anyway='仍然启用 GPU？（缺运行时容器会起不来）'
MSG_en_ask_gpu_enable_anyway='Enable GPU anyway? (the container will not start without the runtime)'
MSG_zh_ask_port='面板端口'
MSG_en_ask_port='Panel port'
MSG_zh_port_invalid='端口须是 1-65535 之间的数字'
MSG_en_port_invalid='The port must be a number between 1 and 65535'
MSG_zh_port_busy='端口 %s 已被占用'
MSG_en_port_busy='Port %s is already in use'
MSG_zh_ask_bind='监听地址'
MSG_en_ask_bind='Listen address'
MSG_zh_bind_all='0.0.0.0（所有网卡）'
MSG_en_bind_all='0.0.0.0 (all interfaces)'
MSG_zh_bind_local='127.0.0.1（仅本机，放在 HTTPS 反代之后时推荐）'
MSG_en_bind_local='127.0.0.1 (local only; recommended behind an HTTPS reverse proxy)'
MSG_zh_bind_custom='自定义…'
MSG_en_bind_custom='Custom…'
MSG_zh_ask_bind_ip='IPv4 地址'
MSG_en_ask_bind_ip='IPv4 address'
MSG_zh_bind_invalid='请输入合法的 IPv4 地址'
MSG_en_bind_invalid='Enter a valid IPv4 address'
MSG_zh_ask_password='管理员密码（留空则随机生成）'
MSG_en_ask_password='Admin password (leave empty to generate one)'
MSG_zh_ask_password_again='再输入一次'
MSG_en_ask_password_again='Repeat the password'
MSG_zh_password_too_short='密码至少 8 位'
MSG_en_password_too_short='The password must be at least 8 characters'
MSG_zh_password_bad_char='密码不能包含单引号'
MSG_en_password_bad_char='The password cannot contain single quotes'
MSG_zh_password_mismatch='两次输入不一致'
MSG_en_password_mismatch='The passwords do not match'
MSG_zh_ask_timezone='时区'
MSG_en_ask_timezone='Timezone'
MSG_zh_timezone_invalid='时区不能为空或包含空格'
MSG_en_timezone_invalid='The timezone cannot be empty or contain spaces'
MSG_zh_ask_llm='配置外部 LLM？（用于解析模型 README 里的推荐参数，可稍后在面板设置页配置）'
MSG_en_ask_llm='Configure an external LLM? (parses recommended parameters from model READMEs; can be set later in panel settings)'
MSG_zh_ask_llm_base_url='Base URL（填到 /v1 为止）'
MSG_en_ask_llm_base_url='Base URL (up to /v1)'
MSG_zh_ask_llm_api_key='API Key'
MSG_en_ask_llm_api_key='API Key'
MSG_zh_ask_llm_model='模型名'
MSG_en_ask_llm_model='Model name'
MSG_zh_summary_title='确认配置（选中某项可修改）'
MSG_en_summary_title='Review the configuration (select an item to change it)'
MSG_zh_summary_confirm='✔ 确认并写入'
MSG_en_summary_confirm='✔ Confirm and write'
MSG_zh_summary_cancel='✘ 取消安装'
MSG_en_summary_cancel='✘ Cancel installation'
MSG_zh_summary_models='模型库：%s'
MSG_en_summary_models='Model library: %s'
MSG_zh_summary_identity='运行身份：%s'
MSG_en_summary_identity='Runtime identity: %s'
MSG_zh_summary_gpu='GPU：%s'
MSG_en_summary_gpu='GPU: %s'
MSG_zh_summary_port='端口：%s'
MSG_en_summary_port='Port: %s'
MSG_zh_summary_bind='监听地址：%s'
MSG_en_summary_bind='Listen address: %s'
MSG_zh_summary_password='管理员密码：%s'
MSG_en_summary_password='Admin password: %s'
MSG_zh_summary_timezone='时区：%s'
MSG_en_summary_timezone='Timezone: %s'
MSG_zh_summary_llm='外部 LLM：%s'
MSG_en_summary_llm='External LLM: %s'
MSG_zh_value_enabled='启用'
MSG_en_value_enabled='enabled'
MSG_zh_value_disabled='不启用'
MSG_en_value_disabled='disabled'
MSG_zh_value_not_configured='未配置'
MSG_en_value_not_configured='not configured'
MSG_zh_value_generated='随机生成'
MSG_en_value_generated='generated'
MSG_zh_install_cancelled='已取消，未写入任何配置'
MSG_en_install_cancelled='Cancelled; no configuration was written'
MSG_zh_apply_failed='写入部署文件失败'
MSG_en_apply_failed='Failed to write the deployment files'
MSG_zh_install_written='部署文件已写入 %s'
MSG_en_install_written='Deployment files written to %s'
MSG_zh_ask_start_now='现在拉取镜像并启动面板？'
MSG_en_ask_start_now='Pull the image and start the panel now?'
MSG_zh_install_done='安装完成'
MSG_en_install_done='Installation complete'
MSG_zh_final_urls='访问地址：'
MSG_en_final_urls='Open the panel at:'
MSG_zh_final_password_generated='管理员密码（随机生成，只显示这一次，已写入 .env）：%s'
MSG_en_final_password_generated='Admin password (generated, shown only once, saved in .env): %s'
MSG_zh_final_env_location='配置文件：%s（改密码、端口等可用 llamapad config）'
MSG_en_final_env_location='Config file: %s (use llamapad config to change the password, port, etc.)'
MSG_zh_final_commands='常用命令：llamapad（菜单）· llamapad start · llamapad status · llamapad logs -f'
MSG_en_final_commands='Common commands: llamapad (menu) · llamapad start · llamapad status · llamapad logs -f'
MSG_zh_env_missing='安装目录里没有 .env，请重新运行安装或 llamapad config'
MSG_en_env_missing='No .env in the install directory; rerun the installer or llamapad config'
MSG_zh_gid_synced='docker.sock 的 gid 变为 %s，已更新 .env'
MSG_en_gid_synced='docker.sock gid is now %s; .env updated'
MSG_zh_models_missing='模型库目录不存在：%s（用 llamapad config 修改位置）'
MSG_en_models_missing='The model library directory does not exist: %s (change it with llamapad config)'
MSG_zh_data_owner_mismatch='data/ 的属主（%s）与运行身份（%s）不一致，面板将无法写入数据库'
MSG_en_data_owner_mismatch='data/ is owned by %s but the panel runs as %s; it will not be able to write its database'
MSG_zh_ask_fix_owner='现在修正 data/ 的属主？'
MSG_en_ask_fix_owner='Fix the owner of data/ now?'
MSG_zh_gpu_runtime_missing='已启用 GPU，但 Docker 没有 NVIDIA 运行时（需要 nvidia-container-toolkit），或用 llamapad config 关闭 GPU'
MSG_en_gpu_runtime_missing='GPU is enabled but Docker has no NVIDIA runtime (install nvidia-container-toolkit), or disable GPU with llamapad config'
MSG_zh_starting='正在启动面板…'
MSG_en_starting='Starting the panel…'
MSG_zh_restarting='正在重建并重启面板…'
MSG_en_restarting='Recreating and restarting the panel…'
MSG_zh_start_failed='docker compose 执行失败'
MSG_en_start_failed='docker compose failed'
MSG_zh_panel_ready='面板已就绪'
MSG_en_panel_ready='The panel is ready'
MSG_zh_panel_not_ready='面板在 %s 秒内未就绪，请用 llamapad logs 查看日志'
MSG_en_panel_not_ready='The panel was not ready within %s seconds; check llamapad logs'
MSG_zh_access_title='访问地址：'
MSG_en_access_title='Open the panel at:'
MSG_zh_stopped='面板已停止'
MSG_en_stopped='The panel has stopped'
MSG_zh_stop_failed='停止失败'
MSG_en_stop_failed='Failed to stop the panel'
MSG_zh_models_still_running='以下模型容器仍在运行（停止面板不会停止它们）：%s'
MSG_en_models_still_running='These model containers are still running (stopping the panel does not stop them): %s'
MSG_zh_ask_stop_models='一并停止这些模型容器？'
MSG_en_ask_stop_models='Stop these model containers too?'
MSG_zh_status_panel='面板：%s'
MSG_en_status_panel='Panel: %s'
MSG_zh_status_not_created='未创建'
MSG_en_status_not_created='not created'
MSG_zh_status_image='镜像：%s'
MSG_en_status_image='Image: %s'
MSG_zh_status_listen='监听：%s:%s'
MSG_en_status_listen='Listening on: %s:%s'
MSG_zh_status_model='运行中的模型：%s'
MSG_en_status_model='Running model: %s'
MSG_zh_status_model_none='无'
MSG_en_status_model_none='none'
MSG_zh_status_gpu='GPU：%s'
MSG_en_status_gpu='GPU: %s'
MSG_zh_status_disk='%s 所在磁盘剩余 %s'
MSG_en_status_disk='Disk holding %s: %s free'
MSG_zh_menu_title='llamapad 部署管理'
MSG_en_menu_title='llamapad deployment manager'
MSG_zh_menu_versions='脚本 v%s · 镜像 %s'
MSG_en_menu_versions='script v%s · image %s'
MSG_zh_menu_dir='目录 %s'
MSG_en_menu_dir='Directory %s'
MSG_zh_item_start='启动'
MSG_en_item_start='Start'
MSG_zh_item_restart='重启'
MSG_en_item_restart='Restart'
MSG_zh_item_stop='停止'
MSG_en_item_stop='Stop'
MSG_zh_item_status='查看状态'
MSG_en_item_status='Status'
MSG_zh_item_logs='查看日志（最近 200 行；持续跟随请用 llamapad logs -f）'
MSG_en_item_logs='Logs (last 200 lines; use llamapad logs -f to follow)'
MSG_zh_item_config='修改配置'
MSG_en_item_config='Change configuration'
MSG_zh_item_upgrade='升级'
MSG_en_item_upgrade='Upgrade'
MSG_zh_item_doctor='环境自检'
MSG_en_item_doctor='Check environment'
MSG_zh_item_uninstall='卸载'
MSG_en_item_uninstall='Uninstall'
MSG_zh_item_exit='退出'
MSG_en_item_exit='Exit'
MSG_zh_config_title='修改配置（改完返回时可选择立即生效）'
MSG_en_config_title='Change configuration (you can apply the changes when leaving)'
MSG_zh_config_password='管理员密码…'
MSG_en_config_password='Admin password…'
MSG_zh_config_back='返回'
MSG_en_config_back='Back'
MSG_zh_config_models_note='模型文件不会被搬动：已有模型配置里的路径相对模型库根目录，换位置后需自行把文件移过去'
MSG_en_config_models_note='Model files are not moved: model configs use paths relative to the library root, so move the files yourself after relocating'
MSG_zh_config_password_generated='新的管理员密码：%s'
MSG_en_config_password_generated='New admin password: %s'
MSG_zh_config_password_note='重启面板后新密码生效，所有已登录的浏览器需要重新登录（API Token 不受影响）'
MSG_en_config_password_note='The new password applies after the panel restarts; every logged-in browser will have to sign in again (API Tokens are unaffected)'
MSG_zh_ask_apply_now='配置已修改，现在重建面板容器使其生效？'
MSG_en_ask_apply_now='Configuration changed. Recreate the panel container now to apply it?'
MSG_zh_config_apply_later='稍后用 llamapad restart 使修改生效'
MSG_en_config_apply_later='Run llamapad restart later to apply the changes'
MSG_zh_identity_apply_failed='数据目录属主修改失败，运行身份未更改'
MSG_en_identity_apply_failed='Failed to change the data directory owner; the run identity was not changed'
MSG_zh_value_bad_char='不能包含单引号或换行'
MSG_en_value_bad_char='Must not contain single quotes or newlines'
MSG_zh_adopt_intro='%s 里已有手工部署的 compose / .env，将接管为脚本管理（先备份，data/ 与模型库不会变动）'
MSG_en_adopt_intro='%s already has a hand-made compose / .env; it will be adopted (backed up first; data/ and the model library stay untouched)'
MSG_zh_adopt_ask_version='原镜像为 %s，要使用的 lancelrq/llamapad 版本'
MSG_en_adopt_ask_version='The current image is %s. lancelrq/llamapad version to use'
MSG_zh_adopt_need_password='原配置没有可用的管理员密码，需要设置一个（面板以它为准）'
MSG_en_adopt_need_password='The existing config has no usable admin password; set one (the panel treats it as the source of truth)'
MSG_zh_adopt_plan_title='接管计划：'
MSG_en_adopt_plan_title='Adoption plan:'
MSG_zh_adopt_plan_image='镜像：%s → %s'
MSG_en_adopt_plan_image='Image: %s → %s'
MSG_zh_adopt_plan_gid='docker.sock gid：自动探测为 %s'
MSG_en_adopt_plan_gid='docker.sock gid: detected as %s'
MSG_zh_adopt_plan_keep='data/ 与模型库保持原样；旧 compose / .env 备份到 backups/'
MSG_en_adopt_plan_keep='data/ and the model library stay as they are; the old compose / .env go to backups/'
MSG_zh_ask_adopt_apply='按此计划接管？'
MSG_en_ask_adopt_apply='Adopt with this plan?'
MSG_zh_adopt_done='接管完成，旧文件备份在 %s'
MSG_en_adopt_done='Adoption complete; old files are backed up in %s'
MSG_zh_menu_update_available='⬆ 有新版本 %s（菜单选「升级」）'
MSG_en_menu_update_available='⬆ Version %s is available (choose Upgrade)'
MSG_zh_latest_fetch_failed='查询最新版本失败（网络受限时可用 --to 指定版本）'
MSG_en_latest_fetch_failed='Failed to look up the latest version (use --to to pick a version on restricted networks)'
MSG_zh_self_updating='正在更新脚本到 v%s…'
MSG_en_self_updating='Updating the script to v%s…'
MSG_zh_image_up_to_date='镜像已是 %s'
MSG_en_image_up_to_date='The image is already %s'
MSG_zh_downgrade_warning='从 %s 降级到 %s：数据库迁移只进不退，降级后旧版本可能无法读取数据'
MSG_en_downgrade_warning='Downgrading from %s to %s: database migrations only move forward, so the older version may not be able to read your data'
MSG_zh_ask_upgrade='把镜像从 %s 切换到 %s？'
MSG_en_ask_upgrade='Switch the image from %s to %s?'
MSG_zh_pull_failed='拉取镜像失败，已恢复原版本号。网络受限时请为 Docker 配置 registry-mirrors 或代理'
MSG_en_pull_failed='Failed to pull the image; the previous version was restored. On restricted networks configure registry-mirrors or a proxy for Docker'
MSG_zh_self_version_mismatch='下载的脚本内容与目标版本号不符，已放弃'
MSG_en_self_version_mismatch='The downloaded script does not match the target version and was discarded'
MSG_zh_self_update_failed='脚本自更新失败，部署脚本仍是当前版本'
MSG_en_self_update_failed='Failed to update the script; it stays at the current version'
MSG_zh_ask_image_only='仅升级镜像，部署脚本保持当前版本？'
MSG_en_ask_image_only='Upgrade only the image and keep the current script version?'
MSG_zh_registry_mirror_hint='网络受限时请为 Docker 配置 registry-mirrors 或代理'
MSG_en_registry_mirror_hint='On restricted networks configure registry-mirrors or a proxy for Docker'
MSG_zh_template_modified='%s 被手动修改过，与新模板的差异如下：'
MSG_en_template_modified='%s was edited by hand; differences from the new template:'
MSG_zh_ask_template_replace='用新模板替换 %s？（原文件会备份到 backups/）'
MSG_en_ask_template_replace='Replace %s with the new template? (the original is backed up to backups/)'
MSG_zh_template_kept='保留了手改的 %s，新模板未应用'
MSG_en_template_kept='Kept your edited %s; the new template was not applied'
MSG_zh_template_updated='已更新 %s'
MSG_en_template_updated='Updated %s'
MSG_zh_doc_platform_ok='宿主机系统：%s'
MSG_en_doc_platform_ok='Host OS: %s'
MSG_zh_doc_docker_ok='Docker 可用（服务端 %s），compose v2 可用'
MSG_en_doc_docker_ok='Docker is available (server %s) with compose v2'
MSG_zh_doc_docker_sudo='当前用户需经 sudo 访问 Docker'
MSG_en_doc_docker_sudo='Your user needs sudo to reach Docker'
# shellcheck disable=SC2016  # 单引号内是展示给用户看的命令示例文本，$USER 不需要在这里展开
MSG_zh_doc_docker_sudo_hint='可把用户加入 docker 组：sudo usermod -aG docker $USER（重新登录生效）'
# shellcheck disable=SC2016  # 同上：单引号内是命令示例文本，$USER 不需要展开
MSG_en_doc_docker_sudo_hint='Add your user to the docker group: sudo usermod -aG docker $USER (log in again afterwards)'
MSG_zh_doc_env_missing_key='.env 缺少必填项 %s'
MSG_en_doc_env_missing_key='.env is missing the required key %s'
MSG_zh_doc_env_missing_hint='用 llamapad config 补齐，或参考 deploy/.env.example'
MSG_en_doc_env_missing_hint='Fill it in with llamapad config, or see deploy/.env.example'
MSG_zh_doc_gid_ok='docker.sock gid 与 .env 一致（%s）'
MSG_en_doc_gid_ok='docker.sock gid matches .env (%s)'
MSG_zh_doc_gid_mismatch='.env 的 DOCKER_GID（%s）与 docker.sock 实际 gid（%s）不一致'
MSG_en_doc_gid_mismatch='DOCKER_GID in .env (%s) differs from the actual docker.sock gid (%s)'
MSG_zh_doc_gid_hint='llamapad start 会自动修正'
MSG_en_doc_gid_hint='llamapad start fixes this automatically'
MSG_zh_doc_gpu_ok='GPU 已启用且 NVIDIA 运行时可用'
MSG_en_doc_gpu_ok='GPU is enabled and the NVIDIA runtime is available'
MSG_zh_doc_gpu_off='未启用 GPU'
MSG_en_doc_gpu_off='GPU is not enabled'
MSG_zh_doc_gpu_available_disabled='检测到显卡，但面板未启用 GPU（显存监控不可用）'
MSG_en_doc_gpu_available_disabled='GPUs are present but the panel does not use them (no VRAM monitoring)'
MSG_zh_doc_gpu_enable_hint='用 llamapad config 开启 GPU'
MSG_en_doc_gpu_enable_hint='Enable GPU with llamapad config'
MSG_zh_doc_port_panel='端口 %s 由面板占用（正在运行）'
MSG_en_doc_port_panel='Port %s is held by the running panel'
MSG_zh_doc_port_free='端口 %s 空闲'
MSG_en_doc_port_free='Port %s is free'
MSG_zh_doc_port_hint='用 llamapad config 换一个端口'
MSG_en_doc_port_hint='Pick another port with llamapad config'
MSG_zh_doc_owner_ok='data/ 属主正确（%s）'
MSG_en_doc_owner_ok='data/ has the right owner (%s)'
MSG_zh_doc_owner_hint='llamapad start 时会提示修正'
MSG_en_doc_owner_hint='llamapad start offers to fix it'
MSG_zh_doc_models_ok='模型库 %s，剩余 %s'
MSG_en_doc_models_ok='Model library %s, %s free'
MSG_zh_doc_models_low='模型库 %s 所在磁盘只剩 %s'
MSG_en_doc_models_low='Model library %s: only %s left on its disk'
MSG_zh_doc_compose_modified='docker-compose.yml 被手动修改过（升级时会展示差异并询问）'
MSG_en_doc_compose_modified='docker-compose.yml was edited by hand (upgrades will show the diff and ask)'
MSG_zh_doc_all_good='自检全部通过'
MSG_en_doc_all_good='All checks passed'
MSG_zh_doc_has_failures='自检发现 %s 项问题'
MSG_en_doc_has_failures='%s problem(s) found'
MSG_zh_ask_uninstall='停止并删除面板容器？（模型容器、数据与模型文件不受影响）'
MSG_en_ask_uninstall='Stop and remove the panel container? (model containers, data and model files are unaffected)'
MSG_zh_compose_down_failed='docker compose down 失败，继续后续步骤'
MSG_en_compose_down_failed='docker compose down failed; continuing'
MSG_zh_launcher_removed='已移除命令入口 %s'
MSG_en_launcher_removed='Removed the command %s'
MSG_zh_uninstall_kept='容器已移除；安装目录 %s（含 data/ 与配置）仍保留'
MSG_en_uninstall_kept='The container is gone; the install directory %s (with data/ and config) is kept'
MSG_zh_ask_delete_home='同时删除安装目录？（面板数据库、配置与备份将永久删除）'
MSG_en_ask_delete_home='Also delete the install directory? (panel database, config and backups will be gone for good)'
MSG_zh_uninstall_foreign_files='安装目录里还有以下不属于 llamapad 的内容，也会被一并删除：'
MSG_en_uninstall_foreign_files='The install directory also has the following content that does not belong to llamapad; it will be deleted too:'
MSG_zh_no_home_permission='当前用户无权读写安装目录 %s，请用 sudo llamapad'
MSG_en_no_home_permission='The current user cannot read/write the install directory %s; use sudo llamapad'
MSG_zh_adopt_permission_denied='该部署属于其他用户，请用 sudo 运行'
MSG_en_adopt_permission_denied='This deployment belongs to another user; run with sudo'
MSG_zh_launcher_install_failed='命令入口未安装，可直接运行 %s'
MSG_en_launcher_install_failed='The llamapad command was not installed; run %s directly instead'
MSG_zh_adopt_plan_password='管理员密码以 .env 为准，旧面板里改过的密码会被覆盖'
MSG_en_adopt_plan_password='The admin password follows .env; a password changed from inside the old panel will be overwritten'
MSG_zh_install_start_failed='配置已写入 %s，但启动失败；排查后执行 llamapad start（或 llamapad doctor）'
MSG_en_install_start_failed='The configuration was written to %s, but the panel failed to start; troubleshoot and run llamapad start (or llamapad doctor)'
MSG_zh_delete_home_includes_models='模型库 %s 在安装目录内，会一并删除'
MSG_en_delete_home_includes_models='The model library %s is inside the install directory and will be deleted too'
MSG_zh_models_outside_kept='模型库 %s 在安装目录之外，不会删除'
MSG_en_models_outside_kept='The model library %s is outside the install directory and will not be deleted'
MSG_zh_type_dir_name='输入目录名 %s 确认删除'
MSG_en_type_dir_name='Type the directory name %s to confirm'
MSG_zh_delete_aborted='目录名不符，已放弃删除'
MSG_en_delete_aborted='The name did not match; nothing was deleted'
MSG_zh_refuse_delete='拒绝删除 %s（不是 llamapad 安装目录或是系统目录）'
MSG_en_refuse_delete='Refusing to delete %s (not a llamapad install directory, or a system directory)'
MSG_zh_home_deleted='已删除 %s'
MSG_en_home_deleted='Deleted %s'
MSG_zh_backup_failed='备份 %s 失败，已中止，原文件未改动'
MSG_en_backup_failed='Failed to back up %s; aborted and left the original file untouched'
MSG_zh_template_restore_failed='恢复 %s 失败，请从 %s 手动找回'
MSG_en_template_restore_failed='Failed to restore %s; recover it manually from %s'
MSG_zh_image_build_failed='构建镜像 %s 失败'
MSG_en_image_build_failed='Failed to build image %s'
MSG_zh_ask_image_source='镜像来源'
MSG_en_ask_image_source='Image source'
MSG_zh_choose_image_hub='Docker Hub %s:%s'
MSG_en_choose_image_hub='Docker Hub %s:%s'
MSG_zh_choose_image_cached='（本地已有，无需下载）'
MSG_en_choose_image_cached='(already local, no download needed)'
MSG_zh_choose_image_local='%s（%s，%s）'
MSG_en_choose_image_local='%s (%s, %s)'
MSG_zh_choose_image_build='从当前仓库构建 %s:%s'
MSG_en_choose_image_build='Build %s:%s from the current repo'
MSG_zh_summary_image='镜像：%s'
MSG_en_summary_image='Image: %s'
MSG_zh_item_build='构建镜像'
MSG_en_item_build='Build image'
MSG_zh_build_repo_not_found='未找到 llamapad 仓库：在仓库根目录运行，或用 --repo 指定'
MSG_en_build_repo_not_found='No llamapad repo found: run this from the repo root, or specify one with --repo'
MSG_zh_build_standalone_done='镜像 %s 已构建'
MSG_en_build_standalone_done='Built image %s'
MSG_zh_build_standalone_hint='未找到已安装的部署，未切换任何配置：运行安装向导时可在「镜像来源」里选它；已安装在别处的，用 --dir <安装目录> 再执行 build 切换'
MSG_en_build_standalone_hint='No installed deployment found, so nothing was switched: pick it under "Image source" in the install wizard, or rerun build with --dir <install dir> to switch an existing installation'
MSG_zh_help_build='本地构建镜像（可用 --repo 指定仓库路径）'
MSG_en_help_build='Build the image locally (use --repo to point at a repo)'
MSG_zh_help_opt_repo='build 使用的仓库路径（默认自动探测）'
MSG_en_help_opt_repo='Repo path used by build (auto-detected by default)'
MSG_zh_ask_upgrade_local_image='当前使用本地镜像，如何升级？'
MSG_en_ask_upgrade_local_image='The panel is running a local image — how do you want to upgrade?'
MSG_zh_upgrade_rebuild_local='从仓库重新构建并重建容器'
MSG_en_upgrade_rebuild_local='Rebuild from the repo and recreate the container'
MSG_zh_upgrade_switch_hub='切换到 Docker Hub 正式版'
MSG_en_upgrade_switch_hub='Switch to a Docker Hub release'
MSG_zh_upgrade_cancel='取消'
MSG_en_upgrade_cancel='Cancel'
MSG_zh_image_restore_failed='恢复镜像名失败，请手动把 .env 的 LLAMAPAD_IMAGE 改回 %s'
MSG_en_image_restore_failed='Failed to restore the image name; manually set LLAMAPAD_IMAGE back to %s in .env'
MSG_zh_upgrade_restart_failed='镜像已切换到 %s，但重建面板容器失败，请排查后执行 llamapad start'
MSG_en_upgrade_restart_failed='Switched to image %s, but failed to recreate the panel container; troubleshoot and run llamapad start'
MSG_zh_build_env_write_failed='写入 .env 失败，构建出的镜像已就绪但未切换'
MSG_en_build_env_write_failed='Failed to write .env; the built image is ready but was not switched to'
MSG_zh_build_state_write_failed='已切换到构建出的镜像，但记录构建来源信息失败（不影响使用，可用 llamapad build 重新记录）'
MSG_en_build_state_write_failed='Switched to the built image, but failed to record its build source (this does not affect usage; run llamapad build again to re-record it)'
MSG_zh_menu_local_image='本地镜像 %s'
MSG_en_menu_local_image='Local image %s'
MSG_zh_local_image_missing='本地镜像 %s 不存在，请先执行 llamapad build'
MSG_en_local_image_missing='Local image %s does not exist; run llamapad build first'
MSG_zh_doc_image_ok='镜像 %s 已就绪'
MSG_en_doc_image_ok='Image %s is ready'
MSG_zh_doc_image_pull_needed='镜像 %s 尚未拉取，首次启动会从 Docker Hub 拉取'
MSG_en_doc_image_pull_needed='Image %s has not been pulled yet; it will be pulled from Docker Hub on first start'
MSG_zh_doc_image_missing='本地镜像 %s 不存在'
MSG_en_doc_image_missing='Local image %s does not exist'
MSG_zh_doc_image_build_hint='执行 llamapad build 构建'
MSG_en_doc_image_build_hint='Run llamapad build to build it'
MSG_zh_adopt_ask_image_source='旧镜像 %s 不是 lancelrq/llamapad，如何处理？'
MSG_en_adopt_ask_image_source='The old image %s is not lancelrq/llamapad — what should we do?'
MSG_zh_adopt_keep_local_image='沿用本地镜像 %s'
MSG_en_adopt_keep_local_image='Keep using the local image %s'
MSG_zh_adopt_use_hub_image='改用 Docker Hub 版本'
MSG_en_adopt_use_hub_image='Switch to a Docker Hub version'

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

# path_forbidden 绝对路径 → 0 表示禁止用作安装/删除目标（危险路径），1 表示可用。
# 拒绝空串、根目录、$HOME、含 /../ 片段或以 /.. 收尾（abs_path 不解析 ..，这里兜底）、
# 以及系统/挂载顶层目录本身（精确匹配，/opt/llamapad 这类子目录不受影响，唯独 /usr 连子目录
# 一并拒绝——/usr/* 下没有第三方安装该待的地方，不像 /opt 天生就是给第三方软件用的）
path_forbidden() {
  local p="$1"
  case "$p" in
    "" | / | "$HOME" | ..) return 0 ;;
    */../* | */..) return 0 ;;
  esac
  case "$p" in
    /opt | /usr | /usr/* | /home | /root | /etc | /var | /bin | /sbin | /lib | /lib64 | /boot | \
      /srv | /mnt | /media | /data | /tmp | /proc | /sys | /dev | /run)
      return 0
      ;;
  esac
  return 1
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
  local f="$1" k="$2" v="$3" line tmp old_umask
  env_valid_value "$v" || return 2
  line="$k=$(env_quote "$v")"
  tmp="$f.tmp.$$"
  # 临时文件可能含密码等敏感值：用 077 的 umask 建它（新文件即 600），
  # 避免默认 umask 下先落一份 644 的明文副本，哪怕转瞬即逝
  old_umask=$(umask)
  umask 077
  if [ -f "$f" ] && grep -q "^$k=" "$f"; then
    LP_LINE="$line" awk -v k="$k=" '
      index($0, k) == 1 { if (!done) { print ENVIRON["LP_LINE"]; done = 1 } next }
      { print }' "$f" >"$tmp" || { rm -f "$tmp"; umask "$old_umask"; return 1; }
  else
    {
      if [ -f "$f" ]; then
        cat "$f"
        [ -z "$(tail -c 1 "$f")" ] || printf '\n'
      fi
      printf '%s\n' "$line"
    } >"$tmp" || { rm -f "$tmp"; umask "$old_umask"; return 1; }
  fi
  umask "$old_umask"
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
  [ -f "$LP_ETC/cdi/nvidia.yaml" ] || [ -f "$LP_RUN/cdi/nvidia.yaml" ]
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

# 交互输出一律写 stderr；按键一律从 $LP_TTY_FD 读（curl | bash 时 stdin 是管道，不能读 stdin）

# 读一行到指定变量。plain 模式的菜单/输入/确认都经这里，测试里替换交互函数时也调它
ui_read_line() {
  IFS= read -r -u "$LP_TTY_FD" "$1"
}

# 数字菜单模式：显式要求、哑终端、stderr 不是终端、或交互输入源没能打开
ui_plain() {
  [ "${LLAMAPAD_PLAIN:-}" = 1 ] && return 0
  [ "${TERM:-dumb}" = dumb ] && return 0
  [ -t 2 ] || return 0
  { : <&"$LP_TTY_FD"; } 2>/dev/null || return 0
  return 1
}

LP_STTY_SAVED=""

# 进入菜单：关回显与行缓冲、隐藏光标、关自动换行（超长行被终端截断而不是折行，重绘行数才算得准）
ui_raw_on() {
  LP_STTY_SAVED=$(stty -g <&"$LP_TTY_FD" 2>/dev/null)
  stty -echo -icanon <&"$LP_TTY_FD" 2>/dev/null
  printf '\033[?25l\033[?7l' >&2
}

ui_raw_off() {
  if [ -n "$LP_STTY_SAVED" ]; then
    stty "$LP_STTY_SAVED" <&"$LP_TTY_FD" 2>/dev/null
    LP_STTY_SAVED=""
  fi
  printf '\033[?25h\033[?7h' >&2
}

# 退出 / 中断时恢复终端（由 main 挂到 trap）
ui_restore() {
  if [ -n "$LP_STTY_SAVED" ]; then ui_raw_off; fi
}

# 读一个按键 → up / down / left / right / enter / backspace / char:<字符>。
# 方向键是 ESC [ X（或 ESC O X）三字节：读到 ESC 再读两字节。不支持单按 ESC（会阻塞等待后续字节）
ui_read_key() {
  local k rest
  IFS= read -rsn1 -u "$LP_TTY_FD" k || return 1
  case "$k" in
    $'\033')
      IFS= read -rsn2 -u "$LP_TTY_FD" rest
      case "$rest" in
        "[A" | OA) echo up ;;
        "[B" | OB) echo down ;;
        "[C" | OC) echo right ;;
        "[D" | OD) echo left ;;
        *) echo other ;;
      esac
      ;;
    "") echo enter ;;
    $'\177' | $'\010') echo backspace ;;
    *) printf 'char:%s\n' "$k" ;;
  esac
}

# ui_menu 标题 选项... → UI_CHOICE（0 起）；q 或输入结束返回 1。UI_DEFAULT 可预设初始选中项（用后清零）
ui_menu() {
  local title="$1" n sel key i ans
  shift
  n=$#
  sel="${UI_DEFAULT:-0}"
  UI_DEFAULT=0
  if ui_plain; then
    printf '%s\n' "$title" >&2
    i=1
    for ans in "$@"; do
      printf '  %d) %s\n' "$i" "$ans" >&2
      i=$((i + 1))
    done
    while :; do
      printf '%s' "$(t ui_number_prompt)" >&2
      ui_read_line ans || return 1
      case "$ans" in
        q | Q) return 1 ;;
        "" | *[!0-9]*) continue ;;
      esac
      if [ "$ans" -ge 1 ] && [ "$ans" -le "$n" ]; then
        UI_CHOICE=$((ans - 1))
        return 0
      fi
    done
  fi
  ui_raw_on
  printf '%s\n' "$title" >&2
  _ui_menu_draw "$sel" "$@"
  while :; do
    key=$(ui_read_key) || { ui_raw_off; return 1; }
    case "$key" in
      up | char:k) sel=$(((sel + n - 1) % n)) ;;
      down | char:j) sel=$(((sel + 1) % n)) ;;
      enter) break ;;
      char:q | char:Q) ui_raw_off; return 1 ;;
      *) continue ;;
    esac
    printf '\033[%dA' "$((n + 1))" >&2
    _ui_menu_draw "$sel" "$@"
  done
  ui_raw_off
  UI_CHOICE=$sel
}

_ui_menu_draw() {
  local sel="$1" i=0 o
  shift
  for o in "$@"; do
    if [ "$i" = "$sel" ]; then
      printf '\r\033[K  %s▶ %s%s\n' "$(lp_sgr '1;36')" "$o" "$(lp_sgr 0)" >&2
    else
      printf '\r\033[K    %s\n' "$o" >&2
    fi
    i=$((i + 1))
  done
  printf '\r\033[K  %s%s%s\n' "$(lp_sgr 2)" "$(t ui_menu_hint)" "$(lp_sgr 0)" >&2
}

# ui_input 提示 默认值 → UI_VALUE。终端模式支持 ←→ 移动光标与退格（按字节计，面向 ASCII 路径与数字）
ui_input() {
  local prompt="$1" def="${2:-}" buf pos key ch
  if ui_plain; then
    if [ -n "$def" ]; then printf '%s [%s]: ' "$prompt" "$def" >&2; else printf '%s: ' "$prompt" >&2; fi
    ui_read_line buf || return 1
    UI_VALUE="${buf:-$def}"
    return 0
  fi
  buf="$def"
  pos=${#buf}
  LP_STTY_SAVED=$(stty -g <&"$LP_TTY_FD" 2>/dev/null)
  stty -echo -icanon <&"$LP_TTY_FD" 2>/dev/null
  while :; do
    printf '\r\033[K%s: %s' "$prompt" "$buf" >&2
    if [ "$pos" -lt "${#buf}" ]; then printf '\033[%dD' "$((${#buf} - pos))" >&2; fi
    key=$(ui_read_key) || { ui_raw_off; return 1; }
    case "$key" in
      enter) break ;;
      left) [ "$pos" -gt 0 ] && pos=$((pos - 1)) ;;
      right) [ "$pos" -lt "${#buf}" ] && pos=$((pos + 1)) ;;
      backspace)
        if [ "$pos" -gt 0 ]; then
          buf="${buf:0:pos-1}${buf:pos}"
          pos=$((pos - 1))
        fi
        ;;
      char:*)
        ch="${key#char:}"
        buf="${buf:0:pos}${ch}${buf:pos}"
        pos=$((pos + 1))
        ;;
    esac
  done
  printf '\n' >&2
  ui_raw_off
  UI_VALUE="$buf"
}

# ui_password 提示 → UI_VALUE（不回显）
ui_password() {
  local p
  printf '%s: ' "$1" >&2
  IFS= read -rs -u "$LP_TTY_FD" p || { printf '\n' >&2; return 1; }
  printf '\n' >&2
  UI_VALUE="$p"
}

_ui_btn() {
  if [ "$2" = 1 ]; then
    printf '%s[ %s ]%s' "$(lp_sgr '1;7')" "$1" "$(lp_sgr 0)"
  else
    printf '  %s  ' "$1"
  fi
}

# ui_confirm 提示 [y|n 默认] → 0 是 / 1 否。终端模式「是 / 否」横排，←→ 切换，也可直接按 y / n
ui_confirm() {
  local prompt="$1" def="${2:-y}" sel key ans
  if ui_plain; then
    while :; do
      if [ "$def" = y ]; then printf '%s (Y/n) ' "$prompt" >&2; else printf '%s (y/N) ' "$prompt" >&2; fi
      ui_read_line ans || return 1
      case "${ans:-$def}" in
        y | Y | yes | YES | 是) return 0 ;;
        n | N | no | NO | 否) return 1 ;;
      esac
    done
  fi
  if [ "$def" = y ]; then sel=0; else sel=1; fi
  ui_raw_on
  while :; do
    printf '\r\033[K%s  %s %s' "$prompt" "$(_ui_btn "$(t ui_yes)" "$([ "$sel" = 0 ] && echo 1)")" \
      "$(_ui_btn "$(t ui_no)" "$([ "$sel" = 1 ] && echo 1)")" >&2
    key=$(ui_read_key) || { ui_raw_off; return 1; }
    case "$key" in
      left | right | char:h | char:l) sel=$((1 - sel)) ;;
      char:y | char:Y) sel=0; break ;;
      char:n | char:N) sel=1; break ;;
      enter) break ;;
    esac
  done
  printf '\n' >&2
  ui_raw_off
  [ "$sel" = 0 ]
}

ui_pause() {
  local _
  printf '%s' "$(t ui_press_enter)" >&2
  ui_read_line _
}

# ===== 8. 模板与写入 =====

# 内嵌模板：必须与 deploy/docker-compose.yml、deploy/docker-compose.gpu.yml 逐字节一致（测试守护），
# 改模板时两边同改，并把 LLAMAPAD_TEMPLATE_VERSION 加 1
tpl_compose() {
  cat <<'LLAMAPAD_COMPOSE_EOF'
# llamapad 部署编排。可变项全部在同目录 .env 里（llamapad.sh 生成并维护，也可手改），
# 本文件通常无需改动；GPU 叠加层见 docker-compose.gpu.yml，由 .env 的 COMPOSE_FILE 启用。
services:
  llamapad:
    image: ${LLAMAPAD_IMAGE:-lancelrq/llamapad}:${LLAMAPAD_VERSION:?请在 .env 设置 LLAMAPAD_VERSION}
    container_name: llamapad
    restart: unless-stopped
    # 运行身份：面板要写 data 与模型库两个 bind 目录，容器内用户必须对它们可写
    user: "${PUID:-1000}:${PGID:-1000}"
    # 端口取在内核临时端口段（Linux 常见 32768-60999）下方，避免与出站连接抢端口；
    # 置于 HTTPS 反代之后时把 PANEL_BIND 设为 127.0.0.1，面板就不会直接暴露在网络上
    ports:
      - "${PANEL_BIND:-0.0.0.0}:${PANEL_PORT:-28960}:28960"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data:/app/config
      # 模型库宿主机路径不必另行告知面板：面板经 docker.sock 查自身挂载表自动识别
      - ${MODELS_DIR:-./models}:/host-models
      # 宿主机网络指标：容器有独立网络命名空间，读 PID 1 的 netns 才是宿主机网卡；
      # 不挂此项时只有网络收发速率两项缺省，其余指标照常
      - /proc:/host/proc:ro
    environment:
      - PANEL_DOCKER=real
      - TZ=${TZ:-Asia/Shanghai}
      - PANEL_CONFIG=/app/config/panel.yaml
      - PANEL_DB=/app/config/panel.db
      # 管理员密码唯一来源：面板启动时与库内不一致即更新，并让全部登录会话失效
      - PANEL_ADMIN_PASSWORD=${PANEL_ADMIN_PASSWORD:?请在 .env 设置 PANEL_ADMIN_PASSWORD}
      - PANEL_LLAMA_HOST=host.docker.internal
      # 外部 LLM（可选，OpenAI 兼容）：README 推荐参数的 AI 解析，留空即未配置
      - PANEL_LLM_BASE_URL=${PANEL_LLM_BASE_URL:-}
      - PANEL_LLM_API_KEY=${PANEL_LLM_API_KEY:-}
      - PANEL_LLM_MODEL=${PANEL_LLM_MODEL:-}
      - PANEL_LLM_EXTRA_BODY=${PANEL_LLM_EXTRA_BODY:-}
    extra_hosts:
      - "host.docker.internal:host-gateway"
    # docker.sock 的 gid 因机器而异；llamapad.sh 每次启动自动探测并写回 .env
    group_add:
      - "${DOCKER_GID:?请在 .env 设置 DOCKER_GID（stat -c %g /var/run/docker.sock）}"
LLAMAPAD_COMPOSE_EOF
}

tpl_compose_gpu() {
  cat <<'LLAMAPAD_GPU_EOF'
# GPU 叠加层：.env 的 COMPOSE_FILE 含本文件时生效（llamapad.sh 按探测结果设置）。
# 面板容器内 nvidia-smi 靠它做显存监控；模型容器的 GPU 参数由面板按模型配置单独传入
services:
  llamapad:
    gpus: all
LLAMAPAD_GPU_EOF
}

compose_file_value() {
  if [ "$1" = 1 ]; then
    printf 'docker-compose.yml:docker-compose.gpu.yml'
  else
    printf 'docker-compose.yml'
  fi
}

# env_gpu_on ENV_FILE → 0 表示该 .env 的 COMPOSE_FILE 叠加了 GPU 层
env_gpu_on() {
  case "$(env_get "$1" COMPOSE_FILE)" in
    *gpu*) return 0 ;;
    *) return 1 ;;
  esac
}

# image_ref [.env 文件，默认 $LP_HOME/.env]：镜像名（缺省 Hub 镜像）+ 版本号，
# printf 输出「镜像名:版本」（不带换行）——供菜单头、status、preflight 等展示/判断复用
image_ref() {
  local f="${1:-$LP_HOME/.env}" name
  name=$(env_get "$f" LLAMAPAD_IMAGE)
  printf '%s:%s' "${name:-$LLAMAPAD_HUB_IMAGE}" "$(env_get "$f" LLAMAPAD_VERSION)"
}

# image_is_hub [.env 文件，默认 $LP_HOME/.env] → 0 表示镜像名为空或等于 Hub 镜像
image_is_hub() {
  local f="${1:-$LP_HOME/.env}" name
  name=$(env_get "$f" LLAMAPAD_IMAGE)
  [ -z "$name" ] || [ "$name" = "$LLAMAPAD_HUB_IMAGE" ]
}

# image_split_ref <镜像引用> → 一行「名<TAB>tag」（不带换行外的其他字符）。
# 按最后一个冒号拆分（而不是第一个）：host:5000/x:tag 这类带 registry:port 的引用，
# 第一个冒号根本不是 tag 分隔符，从那里拆会把 "5000/x:tag" 错当成 tag。
# 拆出来的「tag」部分如果还含 "/"，说明刚才那个冒号其实是 host:port 的一部分、这个引用
# 压根没有 tag（比如 host:5000/x）；连同没有冒号的情形，统一按 Docker 语义补 latest。
# 会先去掉 @sha256:... 这类 digest 后缀，那不是 tag、不该参与拆分。
# tag 是插值表达式且带 bash 修饰符时（比如 myimage:${LLAMAPAD_VERSION:?x}，本脚本自己的
# compose 模板就是这种写法）要先认出 ":${" 这个更早出现的边界——按最后一个冒号拆会拆进
# ${...} 内部，把 :? / :- 这些修饰符错当成 tag 分隔符，产出 tag="?x}" 这种垃圾值
image_split_ref() {
  local ref="${1%%@*}" name tag
  # shellcheck disable=SC2016  # 单引号里是字面量 ":${"/"${"，用来匹配和拼接插值语法的
  # 边界字符，不是期待被展开的变量表达式
  case "$ref" in
    *':${'*)
      name="${ref%%':${'*}"
      tag='${'"${ref#*':${'}"
      ;;
    *:*)
      name="${ref%:*}"
      tag="${ref##*:}"
      case "$tag" in
        */* | "") name="$ref"; tag=latest ;;
      esac
      ;;
    *) name="$ref"; tag=latest ;;
  esac
  printf '%s\t%s\n' "$name" "$tag"
}

# image_local_exists <镜像引用> → 0 表示本地已有该镜像
image_local_exists() {
  dk image inspect "$1" >/dev/null 2>&1
}

# repo_detect DIR → 0 表示该目录是 llamapad 仓库本体：含 Dockerfile，且 package.json 的
# "name" 字段为 llamapad（冒号后允许任意空白，用 grep -E 而非精确字符串匹配）
repo_detect() {
  [ -f "$1/Dockerfile" ] && [ -f "$1/package.json" ] || return 1
  grep -Eq '"name"[[:space:]]*:[[:space:]]*"llamapad"' "$1/package.json"
}

# repo_resolve：printf 输出仓库绝对路径（不带换行），找不到返回 1。
# 优先级 --repo（OPT_REPO） > 当前目录 $PWD > state 里记录的 build_repo（需仍是仓库）
repo_resolve() {
  local p
  if [ -n "$OPT_REPO" ]; then
    p=$(abs_path "$OPT_REPO")
    repo_detect "$p" && { printf '%s' "$p"; return 0; }
    return 1
  fi
  if repo_detect "$PWD"; then
    printf '%s' "$PWD"
    return 0
  fi
  p=$(state_get build_repo 2>/dev/null)
  if [ -n "$p" ] && repo_detect "$p"; then
    printf '%s' "$p"
    return 0
  fi
  return 1
}

# image_build 仓库路径 目标tag：本地构建镜像，透传 Dockerfile 声明的两个代理 ARG
# （HTTP_PROXY/HTTPS_PROXY，大小写形式都识别，优先大写）；构建输出直接透给用户，不吞掉
image_build() {
  local repo="$1" tag="$2" args=() p
  p="${HTTP_PROXY:-$http_proxy}"
  [ -n "$p" ] && args+=(--build-arg "HTTP_PROXY=$p")
  p="${HTTPS_PROXY:-$https_proxy}"
  [ -n "$p" ] && args+=(--build-arg "HTTPS_PROXY=$p")
  if ! dk build "${args[@]}" -t "$tag" "$repo"; then
    err "$(t image_build_failed "$tag")"
    return 1
  fi
}

# MODELS_DIR 可以是相对路径（相对安装目录，compose 也是这么解析的）
models_abs() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    "") printf '%s/models' "$LP_HOME" ;;
    *) printf '%s/%s' "$LP_HOME" "${1#./}" ;;
  esac
}

# 向导答案（W_*）的默认值；安装、接管、修改配置共用这组变量
wizard_defaults() {
  W_VERSION="$LLAMAPAD_SCRIPT_VERSION"
  W_IMAGE="$LLAMAPAD_HUB_IMAGE"
  W_IMAGE_SOURCE=hub
  W_BUILD_REPO=""
  W_MODELS_DIR=""
  W_MODELS_NEW=0
  W_PUID=1000
  W_PGID=1000
  W_GPU=0
  W_PORT="$LLAMAPAD_DEFAULT_PORT"
  W_BIND=0.0.0.0
  W_PASSWORD=""
  W_PASSWORD_GENERATED=0
  W_TZ=UTC
  W_DOCKER_GID=""
  W_LLM_BASE_URL=""
  W_LLM_API_KEY=""
  W_LLM_MODEL=""
}

env_header() {
  printf '%s\n%s\n\n' "$(t env_header_1)" "$(t env_header_2)"
}

# 把 W_* 按键写入 .env（原地替换，保留文件其余内容）
write_env_values() {
  local f="$1"
  env_set "$f" LLAMAPAD_VERSION "$W_VERSION" &&
    env_set "$f" LLAMAPAD_IMAGE "$W_IMAGE" &&
    env_set "$f" COMPOSE_FILE "$(compose_file_value "$W_GPU")" &&
    env_set "$f" PANEL_ADMIN_PASSWORD "$W_PASSWORD" &&
    env_set "$f" DOCKER_GID "$W_DOCKER_GID" &&
    env_set "$f" PUID "$W_PUID" &&
    env_set "$f" PGID "$W_PGID" &&
    env_set "$f" PANEL_BIND "$W_BIND" &&
    env_set "$f" PANEL_PORT "$W_PORT" &&
    env_set "$f" MODELS_DIR "$W_MODELS_DIR" &&
    env_set "$f" TZ "$W_TZ" &&
    env_set "$f" PANEL_LLM_BASE_URL "$W_LLM_BASE_URL" &&
    env_set "$f" PANEL_LLM_API_KEY "$W_LLM_API_KEY" &&
    env_set "$f" PANEL_LLM_MODEL "$W_LLM_MODEL"
}

# 写两个 compose 文件并把校验和记进 state，升级时据此判断用户是否手改过
write_templates() {
  tpl_compose >"$LP_HOME/docker-compose.yml" || return 1
  tpl_compose_gpu >"$LP_HOME/docker-compose.gpu.yml" || return 1
  state_set compose_sha256 "$(sha256_file "$LP_HOME/docker-compose.yml")" &&
    state_set gpu_compose_sha256 "$(sha256_file "$LP_HOME/docker-compose.gpu.yml")" &&
    state_set template_version "$LLAMAPAD_TEMPLATE_VERSION"
}

# fix_owner 目录 UID GID：属主不符时改（先直接改，没权限再提权）
fix_owner() {
  [ "$(stat_owner "$1")" = "$2:$3" ] && return 0
  chown -R "$2:$3" "$1" 2>/dev/null && return 0
  info "$(t chown_need_root "$1" "$2:$3")"
  as_root chown -R "$2:$3" "$1"
}

ensure_models_dir() {
  local d
  d=$(models_abs "$W_MODELS_DIR")
  if [ ! -d "$d" ]; then
    if ! mkdir -p "$d" 2>/dev/null; then
      info "$(t mkdir_need_root "$d")"
      as_root mkdir -p "$d" || return 1
    fi
  fi
  # 只对本次新建的空目录对齐属主；既有模型库动辄上百 GB，绝不 chown
  if [ "$W_MODELS_NEW" = 1 ]; then
    fix_owner "$d" "$W_PUID" "$W_PGID"
  fi
}

# 按 W_* 写出全部部署文件（全新安装与修改后重写共用）。
# state（尤其 installed_at/template_version）必须最后写：入口靠「state 文件存在」判定目录已安装，
# 一旦模型库建不起来之类的步骤半路失败却已经落了 state，重跑会被误判成已安装直接跳过向导
apply_install() {
  local envf="$LP_HOME/.env"
  mkdir -p "$LP_HOME/data" "$LP_HOME/backups" || return 1
  chmod 700 "$LP_HOME/backups" 2>/dev/null
  ensure_models_dir || return 1
  fix_owner "$LP_HOME/data" "$W_PUID" "$W_PGID" || return 1
  write_templates || return 1
  [ -f "$envf" ] || env_header >"$envf" || return 1
  chmod 600 "$envf" || return 1
  write_env_values "$envf" || return 1
  state_set image_source "$W_IMAGE_SOURCE" || return 1
  if [ "$W_IMAGE_SOURCE" = build ]; then
    state_set build_repo "$W_BUILD_REPO" || return 1
  fi
  state_set installed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" || return 1
}

# ===== 9. 安装与向导 =====

# dir_state 目录 → installed / adopt / empty
dir_state() {
  if [ -f "$1/.llamapad-state" ]; then
    printf installed
  elif [ -f "$1/docker-compose.yml" ] || [ -f "$1/.env" ]; then
    printf adopt
  else
    printf empty
  fi
}

# 安装目录候选：--dir > LLAMAPAD_HOME（命令入口设置）> 脚本自身所在目录
home_candidate() {
  if [ -n "$OPT_DIR" ]; then
    abs_path "$OPT_DIR"
  elif [ -n "${LLAMAPAD_HOME:-}" ]; then
    abs_path "$LLAMAPAD_HOME"
  elif [ -n "$LP_SELF" ] && [ -f "$LP_SELF" ]; then
    abs_path "$(dirname "$LP_SELF")"
  fi
}

# 命令入口是两行启动器而非符号链接：安装目录写死在里面，任意目录执行都作用于它，
# 也不依赖 readlink -f 解析链接（busybox 等精简环境同样可用）
launcher_content() {
  printf '#!/bin/sh\nexport LLAMAPAD_HOME=%s\nexec %s "$@"\n' "$(sh_quote "$1")" "$(sh_quote "$1/llamapad.sh")"
}

install_launcher() {
  local home="$1" dst="$LP_BIN_DIR/llamapad" tmp
  if [ -f "$dst" ] && ! grep -qF "$(sh_quote "$home/llamapad.sh")" "$dst"; then
    if ! ui_confirm "$(t launcher_overwrite "$dst")" n; then
      warn "$(t launcher_skipped "$home/llamapad.sh")"
      return 0
    fi
  fi
  tmp="$home/.llamapad-launcher.tmp"
  if ! { launcher_content "$home" >"$tmp" && chmod 755 "$tmp"; }; then
    rm -f "$tmp"
    return 1
  fi
  if [ -d "$LP_BIN_DIR" ] && [ -w "$LP_BIN_DIR" ]; then
    mv "$tmp" "$dst" || { rm -f "$tmp"; return 1; }
  else
    # 经 sudo 落地：mv 是同文件系统内的 rename，不改属主，文件仍归当前用户所有；
    # 改用 install 让内容以 sudo 的身份（root）重新落盘，属主才会变成 root
    if ! ui_confirm "$(t launcher_need_sudo "$dst")" y ||
      ! { as_root mkdir -p "$LP_BIN_DIR" && as_root install -m 755 "$tmp" "$dst"; }; then
      rm -f "$tmp"
      warn "$(t launcher_skipped "$home/llamapad.sh")"
      return 0
    fi
    rm -f "$tmp"
  fi
  ok "$(t launcher_done "$dst")"
}

raw_url() {
  printf '%s/%s/deploy/llamapad.sh' "$LP_RAW_BASE" "$1"
}

# download_to 地址 文件 [超时秒]
download_to() {
  local to="${3:-30}"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 10 --max-time "$to" -o "$2" "$1" 2>/dev/null
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T "$to" -O "$2" "$1" 2>/dev/null
  else
    return 127
  fi
}

# 把脚本本体放进安装目录：真实文件运行时复制自身；curl | bash 时读不到自身，
# 按自身版本的 tag 重新下载（tag 未发布时回退 main），过了 bash -n 才落盘
place_self() {
  local home="$1" dst="$1/llamapad.sh" tmp="$1/.llamapad.sh.tmp"
  if [ -n "$LP_SELF" ] && [ -f "$LP_SELF" ]; then
    [ "$(abs_path "$LP_SELF")" = "$dst" ] && return 0
    cp "$LP_SELF" "$tmp" || return 1
  elif ! download_to "$(raw_url "v$LLAMAPAD_SCRIPT_VERSION")" "$tmp" &&
    ! download_to "$(raw_url main)" "$tmp"; then
    rm -f "$tmp"
    err "$(t self_download_failed)"
    return 1
  fi
  if ! bash -n "$tmp" 2>/dev/null; then
    rm -f "$tmp"
    err "$(t self_syntax_failed)"
    return 1
  fi
  chmod 755 "$tmp" && mv "$tmp" "$dst"
}

ensure_dir_writable() {
  local d="$1"
  mkdir -p "$d" 2>/dev/null
  [ -d "$d" ] && [ -w "$d" ] && return 0
  ui_confirm "$(t dir_need_root "$d")" y || return 1
  as_root mkdir -p "$d" && as_root chown "$(id -u):$(id -g)" "$d"
}

# 接管前置检查：目录本身与已有的 compose/.env 都必须对当前用户可读写，否则大概率是
# 别的用户（或别的 uid）部署的，贸然 ensure_dir_writable（会 chown）会破坏原有归属
adopt_access_ok() {
  local d="$1" f
  [ -r "$d" ] && [ -w "$d" ] || return 1
  for f in docker-compose.yml docker-compose.gpu.yml .env; do
    if [ -e "$d/$f" ]; then
      [ -r "$d/$f" ] && [ -w "$d/$f" ] || return 1
    fi
  done
  return 0
}

disk_type_label() {
  t "disk_type_$1"
}

valid_models_path() {
  case "$1" in /*) ;; *) return 1 ;; esac
  case "$1" in *[[:space:]:\'\"]*) return 1 ;; esac
  return 0
}

models_report() {
  local n size
  n=$(find "$1" -name '*.gguf' -type f 2>/dev/null | wc -l | tr -d ' ')
  [ "${n:-0}" -gt 0 ] || return 0
  size=$(du -sk "$1" 2>/dev/null | awk '{print $1}')
  info "$(t models_found "$n" "$(fmt_kb "${size:-0}")")"
}

# 设置 W_IMAGE、W_VERSION、W_IMAGE_SOURCE（hub|local|build），选 build 时另设 W_BUILD_REPO。
# 选项固定顺序：① Docker Hub 正式版（本地已有该 tag 时标注，默认选中）
# ② 本地已有的、仓库名是 lancelrq/llamapad 或 llamapad 的镜像（docker 不可用或没有则不出现）
# ③ 从当前仓库构建（仅当 $PWD 是 llamapad 仓库时出现）
choose_image() {
  local tab hub_ref repo_name tag created size ref i
  local labels=() refs=() versions=() sources=()
  tab=$(printf '\t')
  hub_ref="$LLAMAPAD_HUB_IMAGE:$LLAMAPAD_SCRIPT_VERSION"
  if image_local_exists "$hub_ref"; then
    labels+=("$(t choose_image_hub "$LLAMAPAD_HUB_IMAGE" "$LLAMAPAD_SCRIPT_VERSION") $(t choose_image_cached)")
  else
    labels+=("$(t choose_image_hub "$LLAMAPAD_HUB_IMAGE" "$LLAMAPAD_SCRIPT_VERSION")")
  fi
  refs+=("$LLAMAPAD_HUB_IMAGE"); versions+=("$LLAMAPAD_SCRIPT_VERSION"); sources+=(hub)

  while IFS="$tab" read -r repo_name tag created size; do
    [ -n "$repo_name" ] || continue
    [ "$tag" = '<none>' ] && continue
    case "$repo_name" in
      "$LLAMAPAD_HUB_IMAGE" | "$LLAMAPAD_DEV_IMAGE") ;;
      *) continue ;;
    esac
    ref="$repo_name:$tag"
    [ "$ref" = "$hub_ref" ] && continue
    labels+=("$(t choose_image_local "$ref" "$created" "$size")")
    refs+=("$repo_name"); versions+=("$tag"); sources+=(local)
  done <<EOF
$(dk images --format "{{.Repository}}${tab}{{.Tag}}${tab}{{.CreatedSince}}${tab}{{.Size}}" 2>/dev/null)
EOF

  if repo_detect "$PWD"; then
    labels+=("$(t choose_image_build "$LLAMAPAD_DEV_IMAGE" "$LLAMAPAD_DEV_TAG")")
    refs+=("$LLAMAPAD_DEV_IMAGE"); versions+=("$LLAMAPAD_DEV_TAG"); sources+=(build)
  fi

  # 默认选中项是当前已选的镜像（从汇总页回头重选时尤其重要，不该每次都跳回 Hub）；
  # 名字和版本号一致还不够，来源也要比对——上一轮选的是「从仓库构建」而本地恰好已经有
  # 同名同版本的镜像时，只比名字/版本会误匹配到「本地」那一项，导致重选时悄悄从
  # build 变成 local（W_BUILD_REPO 也不会再更新）。找不到匹配（第一次进向导）就退回 0
  UI_DEFAULT=0
  for i in "${!refs[@]}"; do
    if [ "${refs[$i]}" = "$W_IMAGE" ] && [ "${versions[$i]}" = "$W_VERSION" ] &&
      [ "${sources[$i]}" = "$W_IMAGE_SOURCE" ]; then
      UI_DEFAULT=$i
      break
    fi
  done
  ui_menu "$(t ask_image_source)" "${labels[@]}" || return 1
  W_IMAGE="${refs[$UI_CHOICE]}"
  W_VERSION="${versions[$UI_CHOICE]}"
  W_IMAGE_SOURCE="${sources[$UI_CHOICE]}"
  # 用 if 而非 "[ ] && ..." 一行式：选中项不是 build 时该式子本身为假，若直接作为函数
  # 最后一条语句，会把这个「假」当成函数的返回码，导致 choose_image 在选 Hub/本地镜像
  # 时也返回失败，把后续的 choose_models_dir 等一并短路掉
  if [ "$W_IMAGE_SOURCE" = build ]; then
    W_BUILD_REPO="$PWD"
  fi
  return 0
}

# 设置 W_MODELS_DIR、W_MODELS_NEW
choose_models_dir() {
  local def="$LP_HOME/models" tab rows p type avail sys label
  local paths=() labels=()
  tab=$(printf '\t')
  rows=$(disk_candidates "$def")
  while IFS="$tab" read -r p type avail sys; do
    [ -n "$p" ] || continue
    label=$(printf '%-40s %-8s %s' "$p" "$(disk_type_label "$type")" "$(t disk_free "$(fmt_kb "$avail")")")
    [ "$sys" = 1 ] && label="$label  $(t disk_system)"
    [ "${avail:-0}" -lt "$LLAMAPAD_MIN_FREE_KB" ] && label="$label  $(t disk_low_space)"
    [ "$type" = network ] && label="$label  $(t disk_network_slow)"
    paths+=("$p")
    labels+=("$label")
  done <<EOF
$rows
EOF
  labels+=("$(t disk_manual)")
  ui_menu "$(t ask_models_dir)" "${labels[@]}" || return 1
  if [ "$UI_CHOICE" -lt "${#paths[@]}" ]; then
    p="${paths[$UI_CHOICE]}"
  else
    while :; do
      ui_input "$(t ask_models_path)" "$def" || return 1
      # 先拦相对路径再转绝对：否则 abs_path 会把它静默拼到当前目录下
      # shellcheck disable=SC2088  # case 模式匹配字面量 "~"/"~/"*，不是期待展开的命令参数，误报
      case "$UI_VALUE" in
        /* | "~" | "~/"*) p=$(abs_path "$UI_VALUE") ;;
        *) p="" ;;
      esac
      valid_models_path "$p" && break
      warn "$(t models_path_invalid)"
    done
  fi
  W_MODELS_DIR="$p"
  if [ -d "$p" ]; then
    W_MODELS_NEW=0
    models_report "$p"
  else
    W_MODELS_NEW=1
  fi
}

# 设置 W_PUID、W_PGID
choose_identity() {
  local cur owner="" v
  cur="$(id -u):$(id -g)"
  if [ "$W_MODELS_NEW" = 0 ] && [ -d "$(models_abs "$W_MODELS_DIR")" ]; then
    owner=$(stat_owner "$(models_abs "$W_MODELS_DIR")")
    ui_menu "$(t ask_identity)" "$(t identity_follow "$owner")" "$(t identity_current "$cur")" \
      "$(t identity_root)" "$(t identity_custom)" || return 1
  else
    owner="1000:1000"
    ui_menu "$(t ask_identity)" "$(t identity_new)" "$(t identity_current "$cur")" \
      "$(t identity_root)" "$(t identity_custom)" || return 1
  fi
  case "$UI_CHOICE" in
    0) v="$owner" ;;
    1) v="$cur" ;;
    2) v="0:0" ;;
    *)
      while :; do
        ui_input "$(t ask_uid_gid)" "$owner" || return 1
        v="$UI_VALUE"
        printf '%s' "$v" | grep -Eq '^[0-9]+:[0-9]+$' && break
        warn "$(t uid_gid_invalid)"
      done
      ;;
  esac
  W_PUID="${v%%:*}"
  W_PGID="${v#*:}"
}

# 设置 W_GPU
choose_gpu() {
  local cards
  cards=$(gpu_cards)
  if [ -z "$cards" ]; then
    info "$(t gpu_none)"
    W_GPU=0
    return 0
  fi
  info "$(t gpu_found)"
  printf '%s\n' "$cards" | sed 's/^/    /' >&2
  if gpu_runtime_ok; then
    if ui_confirm "$(t ask_gpu_enable)" y; then W_GPU=1; else W_GPU=0; fi
  else
    warn "$(t gpu_no_toolkit)"
    if ui_confirm "$(t ask_gpu_enable_anyway)" n; then W_GPU=1; else W_GPU=0; fi
  fi
}

valid_port() {
  case "$1" in "" | *[!0-9]*) return 1 ;; esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

# 设置 W_PORT；可传入一个「允许占用」的端口（修改配置时面板自己正占着当前端口）
choose_port() {
  local allow="${1:-}" p
  while :; do
    ui_input "$(t ask_port)" "$W_PORT" || return 1
    p="$UI_VALUE"
    if ! valid_port "$p"; then
      warn "$(t port_invalid)"
      continue
    fi
    if [ "$p" != "$allow" ] && port_in_use "$p"; then
      warn "$(t port_busy "$p")"
      continue
    fi
    W_PORT="$p"
    return 0
  done
}

valid_ipv4() {
  printf '%s' "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$' || return 1
  local IFS=. o
  # shellcheck disable=SC2086
  set -- $1
  for o in "$@"; do [ "$o" -le 255 ] || return 1; done
}

# 设置 W_BIND
choose_bind() {
  ui_menu "$(t ask_bind)" "$(t bind_all)" "$(t bind_local)" "$(t bind_custom)" || return 1
  case "$UI_CHOICE" in
    0) W_BIND=0.0.0.0 ;;
    1) W_BIND=127.0.0.1 ;;
    *)
      while :; do
        ui_input "$(t ask_bind_ip)" "" || return 1
        valid_ipv4 "$UI_VALUE" && break
        warn "$(t bind_invalid)"
      done
      W_BIND="$UI_VALUE"
      ;;
  esac
}

# 设置 W_PASSWORD、W_PASSWORD_GENERATED
choose_password() {
  local a
  while :; do
    ui_password "$(t ask_password)" || return 1
    a="$UI_VALUE"
    if [ -z "$a" ]; then
      W_PASSWORD=$(gen_password 20)
      W_PASSWORD_GENERATED=1
      return 0
    fi
    if [ "${#a}" -lt 8 ]; then
      warn "$(t password_too_short)"
      continue
    fi
    if ! env_valid_value "$a"; then
      warn "$(t password_bad_char)"
      continue
    fi
    ui_password "$(t ask_password_again)" || return 1
    if [ "$a" != "$UI_VALUE" ]; then
      warn "$(t password_mismatch)"
      continue
    fi
    W_PASSWORD="$a"
    W_PASSWORD_GENERATED=0
    return 0
  done
}

# 设置 W_TZ
choose_timezone() {
  while :; do
    ui_input "$(t ask_timezone)" "$W_TZ" || return 1
    # 含单引号的值 env_set 会拒绝写入（单引号包裹表达不了），与空值、含空格一并在这里挡掉
    case "$UI_VALUE" in
      "" | *[[:space:]]* | *"'"*) warn "$(t timezone_invalid)" ;;
      *) W_TZ="$UI_VALUE"; return 0 ;;
    esac
  done
}

# ui_input_valid 提示 默认值 → UI_VALUE；含单引号或换行的值 env_set 会拒绝写入且不报错，
# 在这里挡在入口处重问，好过让 cmd_config 各分支在写入失败后各自补提示
ui_input_valid() {
  while :; do
    ui_input "$1" "$2" || return 1
    env_valid_value "$UI_VALUE" && return 0
    warn "$(t value_bad_char)"
  done
}

# choose_llm [force]：安装向导先问是否配置；修改配置时传 force 直接进入输入
choose_llm() {
  if [ "${1:-}" != force ] && ! ui_confirm "$(t ask_llm)" n; then
    return 0
  fi
  ui_input_valid "$(t ask_llm_base_url)" "$W_LLM_BASE_URL" || return 1
  W_LLM_BASE_URL="$UI_VALUE"
  ui_input_valid "$(t ask_llm_api_key)" "$W_LLM_API_KEY" || return 1
  W_LLM_API_KEY="$UI_VALUE"
  ui_input_valid "$(t ask_llm_model)" "$W_LLM_MODEL" || return 1
  W_LLM_MODEL="$UI_VALUE"
}

# 汇总页：0 确认、1-9 回头修改对应项、10 取消；确认返回 0，取消返回 1
wizard_summary() {
  local gpu pw llm img
  while :; do
    if [ "$W_GPU" = 1 ]; then gpu=$(t value_enabled); else gpu=$(t value_disabled); fi
    if [ "$W_PASSWORD_GENERATED" = 1 ]; then pw="******** ($(t value_generated))"; else pw="********"; fi
    llm="${W_LLM_BASE_URL:-$(t value_not_configured)}"
    img="$W_IMAGE:$W_VERSION"
    UI_DEFAULT=0
    ui_menu "$(t summary_title)" \
      "$(t summary_confirm)" \
      "$(t summary_image "$img")" \
      "$(t summary_models "$W_MODELS_DIR")" \
      "$(t summary_identity "$W_PUID:$W_PGID")" \
      "$(t summary_gpu "$gpu")" \
      "$(t summary_port "$W_PORT")" \
      "$(t summary_bind "$W_BIND")" \
      "$(t summary_password "$pw")" \
      "$(t summary_timezone "$W_TZ")" \
      "$(t summary_llm "$llm")" \
      "$(t summary_cancel)" || return 1
    case "$UI_CHOICE" in
      0) return 0 ;;
      1) choose_image ;;
      2) choose_models_dir ;;
      3) choose_identity ;;
      4) choose_gpu ;;
      5) choose_port ;;
      6) choose_bind ;;
      7) choose_password ;;
      8) choose_timezone ;;
      9) choose_llm ;;
      *) return 1 ;;
    esac
  done
}

install_final_page() {
  local url
  printf '\n' >&2
  ok "$(t install_done)"
  info "$(t final_urls)"
  while IFS= read -r url; do
    [ -n "$url" ] && info "  $url"
  done <<EOF
$(access_urls "$W_BIND" "$W_PORT")
EOF
  if [ "$W_PASSWORD_GENERATED" = 1 ]; then
    warn "$(t final_password_generated "$W_PASSWORD")"
  fi
  info "$(t final_env_location "$LP_HOME/.env")"
  info "$(t final_commands)"
}

wizard_run() {
  wizard_defaults
  W_DOCKER_GID=$(detect_docker_gid)
  W_TZ=$(detect_timezone)
  info "$(t wizard_intro)"
  if ! { choose_image && choose_models_dir && choose_identity && choose_gpu && choose_port &&
    choose_bind && choose_password && choose_timezone && choose_llm && wizard_summary; }; then
    warn "$(t install_cancelled)"
    return 1
  fi
  if [ "$W_IMAGE_SOURCE" = build ]; then
    image_build "$W_BUILD_REPO" "$W_IMAGE:$W_VERSION" || return 1
  fi
  if ! apply_install; then
    err "$(t apply_failed)"
    return 1
  fi
  ok "$(t install_written "$LP_HOME")"
  if ui_confirm "$(t ask_start_now)" y; then
    if ! cmd_start; then
      err "$(t install_start_failed "$LP_HOME")"
      return 1
    fi
  fi
  install_final_page
}

# cmd_install [默认目录]
cmd_install() {
  local target st n e
  if ! platform_ok; then
    err "$(t unsupported_platform)"
    return 1
  fi
  if ! { : <&"$LP_TTY_FD"; } 2>/dev/null; then
    err "$(t no_tty)"
    return 1
  fi
  info ""
  info "$(t install_welcome "$LLAMAPAD_SCRIPT_VERSION")"
  info "$(t install_dir_note)"
  require_docker || return 1
  while :; do
    ui_input "$(t ask_install_dir)" "${1:-$LLAMAPAD_DEFAULT_HOME}" || return 1
    target=$(abs_path "$UI_VALUE")
    case "$target" in
      *[[:space:]:]*) warn "$(t install_dir_invalid)"; continue ;;
    esac
    if path_forbidden "$target"; then
      err "$(t install_dir_forbidden "$target")"
      continue
    fi
    st=$(dir_state "$target")
    if [ "$st" = empty ] && [ -d "$target" ] && [ -n "$(ls -A "$target" 2>/dev/null)" ]; then
      warn "$(t dir_not_empty "$target")"
      n=0
      for e in "$target"/* "$target"/.[!.]*; do
        [ -e "$e" ] || [ -L "$e" ] || continue
        [ "$n" -lt 10 ] && printf '    %s\n' "$(basename "$e")" >&2
        n=$((n + 1))
      done
      warn "$(t dir_not_empty_hint "$target/llamapad")"
      ui_confirm "$(t ask_use_nonempty_dir)" n || continue
    fi
    break
  done
  if [ "$st" = installed ]; then
    LP_HOME="$target"
    if ! home_access_ok; then
      err "$(t no_home_permission "$target")"
      return 1
    fi
    ok "$(t already_installed "$target")"
    main_menu
    return
  fi
  if [ "$st" = adopt ] && ! adopt_access_ok "$target"; then
    err "$(t adopt_permission_denied)"
    return 1
  fi
  ensure_dir_writable "$target" || return 1
  LP_HOME="$target"
  place_self "$target" || return 1
  install_launcher "$target" || warn "$(t launcher_install_failed "$target/llamapad.sh")"
  if [ "$st" = adopt ]; then
    adopt_run
  else
    wizard_run
  fi
}

# ===== 10. 运维命令 =====

compose() {
  (cd "$LP_HOME" && dk compose "$@")
}

panel_running() {
  [ "$(dk inspect -f '{{.State.Running}}' "$LLAMAPAD_CONTAINER" 2>/dev/null)" = true ]
}

# 启动前检查；DOCKER_GID 每次按 sock 实际属组写回（换机、重装 docker 后 gid 会变）
preflight_start() {
  local envf="$LP_HOME/.env" gid cur port models puid pgid owner
  if [ ! -f "$envf" ]; then
    err "$(t env_missing)"
    return 1
  fi
  if ! image_is_hub "$envf" && ! image_local_exists "$(image_ref "$envf")"; then
    err "$(t local_image_missing "$(image_ref "$envf")")"
    return 1
  fi
  gid=$(detect_docker_gid)
  cur=$(env_get "$envf" DOCKER_GID)
  if [ -n "$gid" ] && [ "$gid" != "$cur" ]; then
    env_set "$envf" DOCKER_GID "$gid" && info "$(t gid_synced "$gid")"
  fi
  if ! panel_running; then
    port=$(env_get "$envf" PANEL_PORT)
    port="${port:-$LLAMAPAD_DEFAULT_PORT}"
    if port_in_use "$port"; then
      err "$(t port_busy "$port")"
      return 1
    fi
  fi
  models=$(models_abs "$(env_get "$envf" MODELS_DIR)")
  if [ ! -d "$models" ]; then
    err "$(t models_missing "$models")"
    return 1
  fi
  puid=$(env_get "$envf" PUID)
  pgid=$(env_get "$envf" PGID)
  puid="${puid:-1000}"
  pgid="${pgid:-1000}"
  owner=$(stat_owner "$LP_HOME/data")
  if [ "$owner" != "$puid:$pgid" ]; then
    warn "$(t data_owner_mismatch "$owner" "$puid:$pgid")"
    if ui_confirm "$(t ask_fix_owner)" y; then
      fix_owner "$LP_HOME/data" "$puid" "$pgid" || return 1
    fi
  fi
  if env_gpu_on "$envf" && ! gpu_runtime_ok; then
    err "$(t gpu_runtime_missing)"
    return 1
  fi
}

# 就绪探测目标固定是本机（127.0.0.1 或 PANEL_BIND），走代理反而绕远、还可能被代理拦下来；
# 显式关代理，不依赖用户机器上没配 http_proxy/NO_PROXY
http_code() {
  if command -v curl >/dev/null 2>&1; then
    curl -s -o /dev/null -w '%{http_code}' --max-time 2 --noproxy '*' "$1" 2>/dev/null
  elif command -v wget >/dev/null 2>&1; then
    # busybox wget 不认识 --no-proxy，会直接报错退出、让就绪探测永远失败；改为清空代理
    # 环境变量后再调用，效果等价且两种 wget 实现都认
    # shellcheck disable=SC1007  # 有意为之：四个变量各自赋空串作为 wget 的临时环境，不是打错的赋值
    http_proxy= HTTP_PROXY= https_proxy= HTTPS_PROXY= wget -q --spider -T 2 "$1" 2>/dev/null && printf 200
  fi
}

# 轮询 /login 至 200；上限 LLAMAPAD_READY_TIMEOUT 秒（默认 60）
wait_ready() {
  local envf="$LP_HOME/.env" port bind host i=0 limit="${LLAMAPAD_READY_TIMEOUT:-60}"
  port=$(env_get "$envf" PANEL_PORT)
  bind=$(env_get "$envf" PANEL_BIND)
  case "$bind" in
    "" | 0.0.0.0) host=127.0.0.1 ;;
    *) host="$bind" ;;
  esac
  while [ "$i" -lt "$limit" ]; do
    [ "$(http_code "http://$host:${port:-$LLAMAPAD_DEFAULT_PORT}/login")" = 200 ] && return 0
    sleep 1
    i=$((i + 1))
  done
  return 1
}

print_access() {
  local url
  info "$(t access_title)"
  while IFS= read -r url; do
    [ -n "$url" ] && info "  $url"
  done <<EOF
$(access_urls "$(env_get "$LP_HOME/.env" PANEL_BIND)" "$(env_get "$LP_HOME/.env" PANEL_PORT)")
EOF
}

# _compose_up [额外参数...]：公共的 up + 等待就绪 + 打印地址
_compose_up() {
  if ! compose up -d "$@"; then
    err "$(t start_failed)"
    info "$(t registry_mirror_hint)"
    return 1
  fi
  if ! wait_ready; then
    err "$(t panel_not_ready "${LLAMAPAD_READY_TIMEOUT:-60}")"
    return 1
  fi
  ok "$(t panel_ready)"
  print_access
}

cmd_start() {
  preflight_start || return 1
  info "$(t starting)"
  _compose_up
}

# 强制重建：compose 只在编排变化时才重建，改 .env 里被插值的值也要确保生效
cmd_restart() {
  preflight_start || return 1
  info "$(t restarting)"
  _compose_up --force-recreate
}

# 本地构建镜像：repo_resolve 找仓库（--repo > $PWD > state 里记录的 build_repo）→ 构建
# 固定的 llamapad:dev → 切 .env 与 state → 问是否立即重建容器
cmd_build() {
  local repo envf="$LP_HOME/.env" tag="$LLAMAPAD_DEV_IMAGE:$LLAMAPAD_DEV_TAG"
  repo=$(repo_resolve) || { err "$(t build_repo_not_found)"; return 1; }
  image_build "$repo" "$tag" || return 1
  # .env 与 state 分两段报错：state 那段失败时 .env 其实已经切过去了，不能笼统说
  # 「未切换」——那会让用户误以为镜像还是旧的，回头却发现面板早就在跑新镜像
  if ! { env_set "$envf" LLAMAPAD_IMAGE "$LLAMAPAD_DEV_IMAGE" &&
    env_set "$envf" LLAMAPAD_VERSION "$LLAMAPAD_DEV_TAG"; }; then
    err "$(t build_env_write_failed)"
    return 1
  fi
  if ! { state_set image_source build && state_set build_repo "$repo"; }; then
    err "$(t build_state_write_failed)"
    return 1
  fi
  if ui_confirm "$(t ask_apply_now)" y; then
    cmd_restart
  else
    info "$(t config_apply_later)"
  fi
}

# 未安装时的构建：只要能定位到仓库就构建 llamapad:dev，不写任何配置——安装向导会把它列进
# 本地镜像，已安装在别处的部署用 --dir 指过去再 build 才会切换
cmd_build_standalone() {
  local repo tag="$LLAMAPAD_DEV_IMAGE:$LLAMAPAD_DEV_TAG"
  repo=$(repo_resolve) || { err "$(t build_repo_not_found)"; return 1; }
  image_build "$repo" "$tag" || return 1
  ok "$(t build_standalone_done "$tag")"
  info "$(t build_standalone_hint)"
}

running_models() {
  dk ps --filter label=llamapad.managed=true --format '{{.Names}}' 2>/dev/null
}

cmd_stop() {
  local models
  models=$(running_models)
  if ! compose stop; then
    err "$(t stop_failed)"
    return 1
  fi
  ok "$(t stopped)"
  if [ -n "$models" ]; then
    warn "$(t models_still_running "$(printf '%s' "$models" | tr '\n' ' ')")"
    if ui_confirm "$(t ask_stop_models)" n; then
      # shellcheck disable=SC2086
      dk stop $models
    fi
  fi
}

panel_status_text() {
  local s
  s=$(dk ps -a --filter "name=^${LLAMAPAD_CONTAINER}$" --format '{{.Status}}' 2>/dev/null | head -n 1)
  printf '%s' "${s:-$(t status_not_created)}"
}

cmd_status() {
  local envf="$LP_HOME/.env" model gpus models_dir
  model=$(dk ps --filter label=llamapad.managed=true --format '{{.Label "llamapad.model"}}' 2>/dev/null | head -n 1)
  info "$(t status_panel "$(panel_status_text)")"
  info "$(t status_image "$(image_ref "$envf")")"
  info "$(t status_listen "$(env_get "$envf" PANEL_BIND)" "$(env_get "$envf" PANEL_PORT)")"
  info "$(t status_model "${model:-$(t status_model_none)}")"
  if command -v "$LP_NVIDIA_SMI" >/dev/null 2>&1; then
    gpus=$("$LP_NVIDIA_SMI" --query-gpu=name,memory.used,memory.total --format=csv,noheader 2>/dev/null | paste -sd ';' -)
    [ -n "$gpus" ] && info "$(t status_gpu "$gpus")"
  fi
  models_dir=$(models_abs "$(env_get "$envf" MODELS_DIR)")
  info "$(t status_disk "$LP_HOME/data" "$(fmt_kb "$(df_avail_kb "$LP_HOME/data")")")"
  [ -d "$models_dir" ] && info "$(t status_disk "$models_dir" "$(fmt_kb "$(df_avail_kb "$models_dir")")")"
  return 0
}

cmd_logs() {
  if [ "$OPT_FOLLOW" = 1 ]; then
    compose logs --tail 200 -f
  else
    compose logs --tail 200
  fi
}

menu_header() {
  local envf="$LP_HOME/.env" model url img latest
  model=$(dk ps --filter label=llamapad.managed=true --format '{{.Label "llamapad.model"}}' 2>/dev/null | head -n 1)
  printf '\n' >&2
  img=$(env_get "$envf" LLAMAPAD_VERSION)
  info "  $(t menu_title)   $(t menu_versions "$LLAMAPAD_SCRIPT_VERSION" "$img")"
  if image_is_hub "$envf"; then
    update_check_cached
    latest=$(state_get update_latest 2>/dev/null)
    if [ -n "$latest" ] && [ "$(ver_cmp "$latest" "$img")" = 1 ]; then
      info "  $(t menu_update_available "$latest")"
    fi
  else
    info "  $(t menu_local_image "$(image_ref "$envf")")"
  fi
  info "  $(t menu_dir "$LP_HOME")   $(t status_panel "$(panel_status_text)")   $(t status_model "${model:-$(t status_model_none)}")"
  url=$(access_urls "$(env_get "$envf" PANEL_BIND)" "$(env_get "$envf" PANEL_PORT)" | head -n 1)
  [ -n "$url" ] && info "  $url"
  printf '\n' >&2
}

# 把 .env 读回 W_*，供修改配置复用安装向导的 choose_* 函数
config_load_env() {
  local envf="$LP_HOME/.env" v
  wizard_defaults
  v=$(env_get "$envf" LLAMAPAD_VERSION) && [ -n "$v" ] && W_VERSION="$v"
  v=$(env_get "$envf" MODELS_DIR) && [ -n "$v" ] && W_MODELS_DIR="$v"
  v=$(env_get "$envf" PUID) && [ -n "$v" ] && W_PUID="$v"
  v=$(env_get "$envf" PGID) && [ -n "$v" ] && W_PGID="$v"
  v=$(env_get "$envf" PANEL_PORT) && [ -n "$v" ] && W_PORT="$v"
  v=$(env_get "$envf" PANEL_BIND) && [ -n "$v" ] && W_BIND="$v"
  v=$(env_get "$envf" PANEL_ADMIN_PASSWORD) && W_PASSWORD="$v"
  v=$(env_get "$envf" TZ) && [ -n "$v" ] && W_TZ="$v"
  v=$(env_get "$envf" DOCKER_GID) && W_DOCKER_GID="$v"
  W_LLM_BASE_URL=$(env_get "$envf" PANEL_LLM_BASE_URL)
  W_LLM_API_KEY=$(env_get "$envf" PANEL_LLM_API_KEY)
  W_LLM_MODEL=$(env_get "$envf" PANEL_LLM_MODEL)
  env_gpu_on "$envf" && W_GPU=1
  if [ -d "$(models_abs "$W_MODELS_DIR")" ]; then W_MODELS_NEW=0; else W_MODELS_NEW=1; fi
}

cmd_config() {
  local envf="$LP_HOME/.env" changed=0 gpu llm allow
  while :; do
    config_load_env
    if [ "$W_GPU" = 1 ]; then gpu=$(t value_enabled); else gpu=$(t value_disabled); fi
    llm="${W_LLM_BASE_URL:-$(t value_not_configured)}"
    ui_menu "$(t config_title)" \
      "$(t summary_port "$W_PORT")" \
      "$(t summary_bind "$W_BIND")" \
      "$(t summary_models "$W_MODELS_DIR")" \
      "$(t summary_identity "$W_PUID:$W_PGID")" \
      "$(t summary_gpu "$gpu")" \
      "$(t summary_timezone "$W_TZ")" \
      "$(t summary_llm "$llm")" \
      "$(t config_password)" \
      "$(t config_back)" || break
    case "$UI_CHOICE" in
      0)
        # 面板正在运行时它自己占着当前端口，不能因此判为「被占用」
        allow=""
        if [ "$DK_STATE" = ok ] && panel_running; then allow="$W_PORT"; fi
        choose_port "$allow" && env_set "$envf" PANEL_PORT "$W_PORT" && changed=1
        ;;
      1) choose_bind && env_set "$envf" PANEL_BIND "$W_BIND" && changed=1 ;;
      2)
        if choose_models_dir && ensure_models_dir && env_set "$envf" MODELS_DIR "$W_MODELS_DIR"; then
          warn "$(t config_models_note)"
          changed=1
        fi
        ;;
      3)
        # 先落实属主再写 .env：属主改不了时旧身份仍与 data/ 一致，不留下「配置已改、目录属主未改」的中间态
        if choose_identity; then
          if fix_owner "$LP_HOME/data" "$W_PUID" "$W_PGID"; then
            env_set "$envf" PUID "$W_PUID" && env_set "$envf" PGID "$W_PGID" && changed=1
          else
            err "$(t identity_apply_failed)"
          fi
        fi
        ;;
      4) choose_gpu && env_set "$envf" COMPOSE_FILE "$(compose_file_value "$W_GPU")" && changed=1 ;;
      5) choose_timezone && env_set "$envf" TZ "$W_TZ" && changed=1 ;;
      6)
        choose_llm force && env_set "$envf" PANEL_LLM_BASE_URL "$W_LLM_BASE_URL" &&
          env_set "$envf" PANEL_LLM_API_KEY "$W_LLM_API_KEY" &&
          env_set "$envf" PANEL_LLM_MODEL "$W_LLM_MODEL" && changed=1
        ;;
      7)
        if choose_password && env_set "$envf" PANEL_ADMIN_PASSWORD "$W_PASSWORD"; then
          [ "$W_PASSWORD_GENERATED" = 1 ] && warn "$(t config_password_generated "$W_PASSWORD")"
          info "$(t config_password_note)"
          changed=1
        fi
        ;;
      *) break ;;
    esac
  done
  [ "$changed" = 1 ] || return 0
  if ui_confirm "$(t ask_apply_now)" y; then
    cmd_restart
  else
    info "$(t config_apply_later)"
  fi
}

main_menu() {
  local start_label items=() actions=()
  require_docker || return 1
  while :; do
    menu_header
    if panel_running; then start_label=$(t item_restart); else start_label=$(t item_start); fi
    items=("$start_label" "$(t item_stop)" "$(t item_status)" "$(t item_logs)" "$(t item_config)")
    actions=(start stop status logs config)
    # 「构建镜像」只在能找到仓库时出现（--repo > $PWD > state 记录的 build_repo）；
    # 用平行的 actions 数组而非死记选项下标做分发，插不插这一项都不必再对下面的 case 改账
    if repo_resolve >/dev/null 2>&1; then
      items+=("$(t item_build)")
      actions+=(build)
    fi
    items+=("$(t item_upgrade)" "$(t item_doctor)" "$(t item_uninstall)" "$(t item_exit)")
    actions+=(upgrade doctor uninstall exit)
    ui_menu "" "${items[@]}" || return 0
    case "${actions[$UI_CHOICE]:-exit}" in
      start) if panel_running; then cmd_restart; else cmd_start; fi ;;
      stop) cmd_stop ;;
      status) cmd_status ;;
      logs) OPT_FOLLOW=0; cmd_logs ;;
      config) cmd_config ;;
      build) cmd_build ;;
      upgrade) cmd_upgrade ;;
      doctor) cmd_doctor ;;
      uninstall) cmd_uninstall && [ ! -d "$LP_HOME" ] && return 0 ;;
      *) return 0 ;;
    esac
    ui_pause
  done
}

# ===== 11. 接管 =====

# 从旧 compose 里读出 MODELS_DIR=… / GPU=0|1 / IMAGE=…
adopt_extract_compose() {
  local f="$1" models image
  models=$(grep ':/host-models' "$f" | head -n 1 |
    sed -E "s/^[[:space:]]*-[[:space:]]*//; s/^[\"']//; s#:/host-models.*##")
  image=$(grep -E '^[[:space:]]*image:' "$f" | head -n 1 |
    sed -E "s/^[[:space:]]*image:[[:space:]]*//; s/[[:space:]]+#.*$//; s/^[\"']//; s/[\"']$//")
  printf 'MODELS_DIR=%s\n' "$models"
  if grep -Eq '^[[:space:]]*gpus:' "$f"; then echo GPU=1; else echo GPU=0; fi
  printf 'IMAGE=%s\n' "$image"
}

adopt_show_plan() {
  local old_image="$1" gpu
  if [ "$W_GPU" = 1 ]; then gpu=$(t value_enabled); else gpu=$(t value_disabled); fi
  info "$(t adopt_plan_title)"
  info "  $(t adopt_plan_image "${old_image:-?}" "$W_IMAGE:$W_VERSION")"
  info "  $(t adopt_plan_gid "$W_DOCKER_GID")"
  info "  $(t summary_models "$W_MODELS_DIR")"
  info "  $(t summary_gpu "$gpu")"
  info "  $(t summary_identity "$W_PUID:$W_PGID")"
  info "  $(t summary_port "$W_PORT")"
  info "  $(t adopt_plan_keep)"
  info "  $(t adopt_plan_password)"
}

adopt_run() {
  local envf="$LP_HOME/.env" cf="$LP_HOME/docker-compose.yml" kv models="" gpu=0 image="" v owner bdir f local_opt
  local tab split split_name split_tag
  wizard_defaults
  info "$(t adopt_intro "$LP_HOME")"
  if [ -f "$cf" ]; then
    while IFS= read -r kv; do
      case "$kv" in
        MODELS_DIR=*) models="${kv#*=}" ;;
        GPU=*) gpu="${kv#*=}" ;;
        IMAGE=*) image="${kv#*=}" ;;
      esac
    done <<EOF
$(adopt_extract_compose "$cf")
EOF
  fi

  # 新版 compose 里挂载与镜像都是插值，真实值在 .env
  # shellcheck disable=SC2016  # 单引号里是 case 模式字面量 "${"，判断是否为插值占位符，不是期待展开的表达式
  case "$models" in
    "" | '${'*) models=$(env_get "$envf" MODELS_DIR) ;;
  esac
  W_MODELS_DIR="${models:-./models}"
  W_MODELS_NEW=0
  env_gpu_on "$envf" && gpu=1
  W_GPU="$gpu"
  # shellcheck disable=SC2016  # 单引号里是 case 模式字面量 "${"，判断是否为插值占位符
  case "$image" in
    '${'*)
      # 旧 compose 已是本脚本自己的插值模板（镜像名与版本都写成 ${...}）：直接信 .env 的记录值，
      # 不再问——这类部署本就是本脚本或按文档手工照抄新模板生成的，.env 才是唯一真源
      v=$(env_get "$envf" LLAMAPAD_IMAGE)
      W_IMAGE="${v:-$LLAMAPAD_HUB_IMAGE}"
      v=$(env_get "$envf" LLAMAPAD_VERSION)
      W_VERSION="${v:-$LLAMAPAD_SCRIPT_VERSION}"
      if image_is_hub "$envf"; then W_IMAGE_SOURCE=hub; else W_IMAGE_SOURCE=local; fi
      ;;
    "$LLAMAPAD_HUB_IMAGE:"*)
      v="${image#"$LLAMAPAD_HUB_IMAGE:"}"
      # shellcheck disable=SC2016  # 同上：case 模式字面量，不是期待展开的表达式
      case "$v" in '${'*) v=$(env_get "$envf" LLAMAPAD_VERSION) ;; esac
      W_VERSION="${v:-$LLAMAPAD_SCRIPT_VERSION}"
      W_IMAGE="$LLAMAPAD_HUB_IMAGE"
      W_IMAGE_SOURCE=hub
      ;;
    *)
      # 自定义/本地构建的镜像：用 image_split_ref 拆出「名:tag」（插值 tag 以 ":${" 为界，
      # 否则按最后一个冒号拆；处理 host:port/repo 与没有 tag 的情形）。tag 恰好是插值占位符时
      # 读 .env 的 LLAMAPAD_VERSION——读不到就不给「沿用」选项，沿用了也起不来
      tab=$(printf '\t')
      split=$(image_split_ref "$image")
      IFS="$tab" read -r split_name split_tag <<EOF
$split
EOF
      # shellcheck disable=SC2016  # 单引号里是 case 模式字面量 "${"，判断是否为插值占位符
      case "$split_tag" in '${'*) split_tag=$(env_get "$envf" LLAMAPAD_VERSION) ;; esac
      local_opt=""
      [ -n "$split_tag" ] && local_opt="$(t adopt_keep_local_image "$split_name:$split_tag")"
      if [ -n "$local_opt" ]; then
        ui_menu "$(t adopt_ask_image_source "${image:-?}")" "$local_opt" "$(t adopt_use_hub_image)" || return 1
      else
        ui_menu "$(t adopt_ask_image_source "${image:-?}")" "$(t adopt_use_hub_image)" || return 1
      fi
      if [ -n "$local_opt" ] && [ "$UI_CHOICE" = 0 ]; then
        W_IMAGE="$split_name"
        W_VERSION="$split_tag"
        W_IMAGE_SOURCE=local
      else
        ui_input "$(t adopt_ask_version "${image:-?}")" "$LLAMAPAD_SCRIPT_VERSION" || return 1
        W_VERSION="${UI_VALUE#v}"
        W_IMAGE="$LLAMAPAD_HUB_IMAGE"
        W_IMAGE_SOURCE=hub
      fi
      ;;
  esac

  W_PASSWORD=$(env_get "$envf" PANEL_ADMIN_PASSWORD)
  v=$(env_get "$envf" PUID)
  if [ -n "$v" ]; then
    W_PUID="$v"
    W_PGID=$(env_get "$envf" PGID)
    W_PGID="${W_PGID:-$v}"
  elif [ -d "$LP_HOME/data" ]; then
    owner=$(stat_owner "$LP_HOME/data")
    W_PUID="${owner%%:*}"
    W_PGID="${owner#*:}"
  fi
  v=$(env_get "$envf" PANEL_PORT) && [ -n "$v" ] && W_PORT="$v"
  v=$(env_get "$envf" PANEL_BIND) && [ -n "$v" ] && W_BIND="$v"
  v=$(env_get "$envf" TZ)
  if [ -n "$v" ]; then W_TZ="$v"; else W_TZ=$(detect_timezone); fi
  W_LLM_BASE_URL=$(env_get "$envf" PANEL_LLM_BASE_URL)
  W_LLM_API_KEY=$(env_get "$envf" PANEL_LLM_API_KEY)
  W_LLM_MODEL=$(env_get "$envf" PANEL_LLM_MODEL)
  W_DOCKER_GID=$(detect_docker_gid)

  if [ -z "$W_PASSWORD" ] || ! env_valid_value "$W_PASSWORD"; then
    warn "$(t adopt_need_password)"
    choose_password || return 1
  fi

  adopt_show_plan "$image"
  if ! ui_confirm "$(t ask_adopt_apply)" y; then
    warn "$(t install_cancelled)"
    return 1
  fi

  bdir="$LP_HOME/backups/adopt-$(date +%Y%m%d-%H%M%S)"
  if ! mkdir -p "$bdir"; then
    err "$(t backup_failed "$bdir")"
    return 1
  fi
  chmod 700 "$LP_HOME/backups" 2>/dev/null
  # [ -f ] 为假时整个条件短路为假（文件本就不存在，跳过属正常）；
  # 只有文件存在但 cp 失败才应中止，两种情况不能混为一谈
  for f in docker-compose.yml docker-compose.gpu.yml .env; do
    if [ -f "$LP_HOME/$f" ] && ! cp -p "$LP_HOME/$f" "$bdir/"; then
      err "$(t backup_failed "$f")"
      return 1
    fi
  done
  if ! apply_install; then
    err "$(t apply_failed)"
    return 1
  fi
  state_set adopted_from "$bdir"
  ok "$(t adopt_done "$bdir")"
  if ui_confirm "$(t ask_start_now)" y; then
    if ! cmd_start; then
      err "$(t install_start_failed "$LP_HOME")"
      return 1
    fi
  fi
  install_final_page
}

# ===== 12. 升级 =====

# fetch_latest_version [超时秒] → Docker Hub 上最大的正式版本
fetch_latest_version() {
  local tmp v=""
  tmp=$(mktemp 2>/dev/null) || return 1
  if download_to "$LP_HUB_TAGS_URL" "$tmp" "${1:-10}"; then
    v=$(hub_tags_parse <"$tmp" | ver_latest_stable)
  fi
  rm -f "$tmp"
  [ -n "$v" ] || return 1
  printf '%s\n' "$v"
}

# 每 24 小时至多联网一次，超时 2 秒；失败不影响任何流程
update_check_cached() {
  local now last v
  now=$(date +%s)
  last=$(state_get update_checked_at 2>/dev/null)
  [ $((now - ${last:-0})) -ge 86400 ] || return 0
  state_set update_checked_at "$now"
  if v=$(fetch_latest_version 2); then
    state_set update_latest "$v"
  fi
}

# self_update 只返回成功与否，失败原因记在 SELF_UPDATE_REASON（文案键名）里，不在这里
# 直接 err——是否该显示成 ✘ 由调用方按上下文判断（升级流程里镜像已经是目标版本、只是
# 脚本自身落后这种情形，自更新失败根本不算「升级失败」，打 ✘ 会误导用户）
self_update() {
  local target="$1" tmp="$LP_HOME/.llamapad.sh.new"
  info "$(t self_updating "$target")"
  SELF_UPDATE_REASON=""
  # 下载/校验途中被 Ctrl-C 或 kill 时清掉半截临时文件。trap 体读全局 SELF_UPDATE_TMP，
  # 不把路径拼进 trap 字符串（路径含单引号时会拼坏）；结束后恢复 main 设置的默认 trap
  SELF_UPDATE_TMP="$tmp"
  trap 'rm -f "$SELF_UPDATE_TMP"; ui_restore; exit 130' INT TERM
  _self_update_run "$target" "$tmp"
  local rc=$?
  trap 'ui_restore; exit 130' INT TERM
  return "$rc"
}

_self_update_run() {
  local target="$1" tmp="$2" want_line
  if ! download_to "$(raw_url "v$target")" "$tmp"; then
    rm -f "$tmp"
    SELF_UPDATE_REASON=self_download_failed
    return 1
  fi
  if ! bash -n "$tmp" 2>/dev/null; then
    rm -f "$tmp"
    SELF_UPDATE_REASON=self_syntax_failed
    return 1
  fi
  # 语法合法不代表内容就是目标版本（可能拿到别的 ref、或镜像返回了旧内容）；
  # 精确匹配这一行（与脚本自身第 19 行的写法一致）比 grep 版本号更不容易被误判
  want_line="LLAMAPAD_SCRIPT_VERSION=\"$target\""
  if ! grep -qxF "$want_line" "$tmp"; then
    rm -f "$tmp"
    SELF_UPDATE_REASON=self_version_mismatch
    return 1
  fi
  if ! mkdir -p "$LP_HOME/backups"; then
    rm -f "$tmp"
    return 1
  fi
  chmod 700 "$LP_HOME/backups" 2>/dev/null
  if ! cp -p "$LP_HOME/llamapad.sh" "$LP_HOME/backups/llamapad.sh.$(date +%Y%m%d-%H%M%S)"; then
    rm -f "$tmp"
    return 1
  fi
  if ! { chmod 755 "$tmp" && mv "$tmp" "$LP_HOME/llamapad.sh"; }; then
    rm -f "$tmp"
    return 1
  fi
}

# 本次 template_sync 实际替换过的文件，供失败时回滚（升级 pull 失败等场景）消费：
# 每行「文件名<TAB>state 键<TAB>替换前校验和<TAB>备份路径」，只在成功备份后才追加一行
TEMPLATE_SYNC_LOG=""
# 本次是否推进过 template_version，以及推进前的旧值，同样只供回滚使用
TEMPLATE_SYNC_BUMPED=0
TEMPLATE_SYNC_OLD_TVER=""

# 只在内嵌模板版本比已安装的新时才处理：版本没变就跳过已存在的文件，
# 不比对校验和、不弹 diff——避免同一版本模板反复纠缠用户。
# 文件缺失一律直接写入（新装或历史遗留都一样，与版本号无关）。
# 版本变大时：用户没改过（校验和等于 state 记录）静默替换；手改过则展示 diff 让用户决定
# （默认保留原文件）；替换前一律备份
template_sync() {
  local spec file fn key tmp cur recorded ts old_tver need_check=0
  ts=$(date +%Y%m%d-%H%M%S)
  TEMPLATE_SYNC_LOG=""
  TEMPLATE_SYNC_BUMPED=0
  old_tver=$(state_get template_version 2>/dev/null)
  old_tver="${old_tver:-0}"
  TEMPLATE_SYNC_OLD_TVER="$old_tver"
  [ "$old_tver" -lt "$LLAMAPAD_TEMPLATE_VERSION" ] && need_check=1
  for spec in "docker-compose.yml:tpl_compose:compose_sha256" "docker-compose.gpu.yml:tpl_compose_gpu:gpu_compose_sha256"; do
    file="${spec%%:*}"
    key="${spec##*:}"
    fn="${spec#*:}"
    fn="${fn%%:*}"
    if [ -f "$LP_HOME/$file" ] && [ "$need_check" != 1 ]; then
      continue
    fi
    tmp="$LP_HOME/.$file.new"
    "$fn" >"$tmp" || { rm -f "$tmp"; return 1; }
    cur=""
    [ -f "$LP_HOME/$file" ] && cur=$(sha256_file "$LP_HOME/$file")
    if [ "$cur" = "$(sha256_file "$tmp")" ]; then
      rm -f "$tmp"
      state_set "$key" "$cur"
      continue
    fi
    if [ -n "$cur" ]; then
      recorded=$(state_get "$key")
      if [ "$cur" != "$recorded" ]; then
        warn "$(t template_modified "$file")"
        diff -u "$LP_HOME/$file" "$tmp" >&2
        if ! ui_confirm "$(t ask_template_replace "$file")" n; then
          rm -f "$tmp"
          warn "$(t template_kept "$file")"
          continue
        fi
      fi
    fi
    if ! mkdir -p "$LP_HOME/backups"; then
      rm -f "$tmp"
      err "$(t backup_failed "$file")"
      return 1
    fi
    chmod 700 "$LP_HOME/backups" 2>/dev/null
    if [ -f "$LP_HOME/$file" ]; then
      if ! cp -p "$LP_HOME/$file" "$LP_HOME/backups/$file.$ts"; then
        rm -f "$tmp"
        err "$(t backup_failed "$file")"
        return 1
      fi
      # 记录 state 里替换前的 recorded 值（而非磁盘上手改文件的 sha）：回滚要撤销的是这次
      # template_sync 对 state 做的改动，state 在这次调用前的值就是 recorded，不是 cur
      TEMPLATE_SYNC_LOG="$TEMPLATE_SYNC_LOG$file	$key	$recorded	$LP_HOME/backups/$file.$ts
"
    fi
    mv "$tmp" "$LP_HOME/$file" && state_set "$key" "$(sha256_file "$LP_HOME/$file")" && info "$(t template_updated "$file")"
  done
  if [ "$need_check" = 1 ]; then
    state_set template_version "$LLAMAPAD_TEMPLATE_VERSION"
    TEMPLATE_SYNC_BUMPED=1
  fi
}

# 回滚本次 template_sync 实际做出的改动（升级流程在自身失败时调用）：
# 逐行把备份 cp 回去、state 复原；备份缺失或复原失败只 warn 给出备份路径，不中止流程
# （此时调用方本就在处理另一个失败，不应该在回滚上再报错卡住）
template_sync_rollback() {
  local line file key oldsha backup tab
  tab=$(printf '\t')
  while IFS="$tab" read -r file key oldsha backup; do
    [ -n "$file" ] || continue
    if [ -f "$backup" ] && cp -p "$backup" "$LP_HOME/$file"; then
      state_set "$key" "$oldsha"
    else
      warn "$(t template_restore_failed "$file" "$backup")"
    fi
  done <<EOF
$TEMPLATE_SYNC_LOG
EOF
  [ "$TEMPLATE_SYNC_BUMPED" = 1 ] && state_set template_version "$TEMPLATE_SYNC_OLD_TVER"
}

# 回滚本次 _upgrade_apply 写入的目标镜像名（未写入过、或 from_local=0 时是无害的 no-op）；
# env_set 失败不吞掉——报错并提示用户手动检查，不能假装已经恢复
_upgrade_rollback_image() {
  local from_local="$1" orig="$2"
  [ "$from_local" = 1 ] && [ -n "$orig" ] || return 0
  env_set "$LP_HOME/.env" LLAMAPAD_IMAGE "$orig" || err "$(t image_restore_failed "$orig")"
}

# 把 .env 的镜像升到目标版本，原 cmd_upgrade 的全部判断顺序未改动，只从中抽出来供
# 「本地镜像切回 Hub」复用。
#   $1 = from_local（1 表示当前在用本地镜像，这次调用是切回/确认走 Hub）
#   $2 = want_image（from_local=1 时要切到的镜像名；只在「确认升级」之后才 env_set 进
#        .env——早于确认的任何失败/中断都不会碰 .env，Ctrl-C 不会留下半改的镜像名）
#   $3 = orig_image（from_local=1 时的原镜像名，用于失败时回滚；不传时在函数开头从 .env
#        读。第一阶段不写镜像名，所以两个阶段进来时 .env 的 LLAMAPAD_IMAGE 都还是原值；
#        第二阶段仍以旧脚本导出的 LLAMAPAD_UPGRADE_REVERT_IMAGE 为准传入，不依赖这一点）
# 结果记在全局 UPGRADE_OUTCOME 而不是返回码里：declined（拒绝「是否升级」，未做任何改动）/
# rolled_back（曾经改动或本该改动但整体失败，已撤销/无需撤销）/ applied（已完整应用，
# 含无需改动的情形）/ restart_failed（pull 已成功但重建容器失败——保留新镜像名与新版本，
# 与既有「Hub 升级重建失败不回滚」的行为一致，只提示排查后手动 llamapad start）。
# 「拒绝是否升级」与「自更新失败后拒绝仅升级镜像」这两种「什么都没做」在现有契约里对外
# 返回码不同（前者 0、后者 1，测试已锁定这个历史行为），所以不能只用返回码传递结果，
# 一句「哨兵返回码」也不用了——2 会跟 env_set 的「值非法」返回码撞车，用变量更明确。
_upgrade_apply() {
  local from_local="${1:-0}" want_image="${2:-}" orig_image="${3:-}" envf="$LP_HOME/.env" target cur cmp def
  [ -n "$orig_image" ] || orig_image=$(env_get "$envf" LLAMAPAD_IMAGE)
  target="${OPT_TO#v}"
  if [ -z "$target" ]; then
    target=$(fetch_latest_version)
    if [ -z "$target" ]; then
      err "$(t latest_fetch_failed)"
      UPGRADE_OUTCOME=rolled_back
      return 1
    fi
  fi
  cur=$(env_get "$envf" LLAMAPAD_VERSION)
  if [ "$from_local" = 1 ]; then cmp=1; else cmp=$(ver_cmp "$target" "$cur"); fi

  if [ "$cmp" = 0 ]; then
    info "$(t image_up_to_date "$cur")"
    if [ "$target" = "$LLAMAPAD_SCRIPT_VERSION" ]; then
      if ! template_sync; then
        UPGRADE_OUTCOME=rolled_back
        return 1
      fi
      UPGRADE_OUTCOME=applied
      return 0
    fi
  elif [ "${LLAMAPAD_UPGRADE_CONFIRMED:-}" != 1 ]; then
    [ "$cmp" = -1 ] && warn "$(t downgrade_warning "$cur" "$target")"
    if [ "$cmp" = 1 ]; then def=y; else def=n; fi
    if ! ui_confirm "$(t ask_upgrade "$cur" "$target")" "$def"; then
      UPGRADE_OUTCOME=declined
      return 0
    fi
  fi

  # 升级已确认（或第二阶段本就带着 CONFIRMED=1 进来）。走到这里之前 .env 还没被本函数
  # 改动过一个字节——镜像名不在这里写，等下面真正要写 VERSION 的那一刻才跟 VERSION
  # 一起写；这样自更新需要与否、自更新失败后拒不拒绝「仅升级镜像」都不影响这个事实：
  # 从「确认升级」到「真正落盘」之间的任何失败/中断（Ctrl-C、下载卡住被杀、exec 到的新
  # 进程在走到这里之前就退出）都不会把 .env 改成一半新一半旧的不存在组合
  if [ "$target" != "$LLAMAPAD_SCRIPT_VERSION" ] && [ "${LLAMAPAD_UPGRADE_STAGE:-}" != 2 ]; then
    if self_update "$target"; then
      # 第一阶段由用户机器上已安装的旧脚本执行；upgrade --to <ver> --dir <dir> --lang <lang>
      # 与 LLAMAPAD_UPGRADE_STAGE / LLAMAPAD_UPGRADE_CONFIRMED 是跨版本接口（旧脚本 exec 新脚本），
      # 只增不改，否则装着旧脚本的机器升级时会传出新脚本读不懂的参数。
      # LLAMAPAD_UPGRADE_REVERT_IMAGE 与它们并列，同属这组跨版本接口，承担两件事：
      # ① 它是第二阶段判定「这次是本地镜像切回 Hub、要把 .env 镜像名写成 Hub」的唯一信号
      # （变量存在即切 Hub，第二阶段不再出菜单）；② 值是切换前的原镜像名，供失败时回滚。
      # 只在「本地镜像切 Hub 且这次确实需要自更新」时才导出——新脚本只在自己也处于
      # LLAMAPAD_UPGRADE_STAGE=2 时读取它
      # （见 cmd_upgrade），读到后立即 unset，避免残留环境变量污染同一 shell 里下一次
      # cmd_upgrade 调用（比如 main_menu 循环里再次点「升级」）。注意这里只导出原镜像名，
      # 不写 .env 的 LLAMAPAD_IMAGE——那件事留给第二阶段进程自己去做（它清楚要写什么）
      export LLAMAPAD_UPGRADE_STAGE=2 LLAMAPAD_UPGRADE_CONFIRMED=1
      [ "$from_local" = 1 ] && export LLAMAPAD_UPGRADE_REVERT_IMAGE="$orig_image"
      exec "$LP_HOME/llamapad.sh" upgrade --to "$target" --dir "$LP_HOME" --lang "$LP_LANG"
    fi
    # self_update 只返回成功与否，具体原因在 SELF_UPDATE_REASON；这里按 cmp 决定用
    # warn 还是 err——cmp=0 时镜像本就已经是目标版本，自更新没做成不算「升级失败」
    if [ "$cmp" = 0 ]; then
      warn "$(t self_update_failed)"
      [ -n "$SELF_UPDATE_REASON" ] && warn "$(t "$SELF_UPDATE_REASON")"
      if ! template_sync; then
        UPGRADE_OUTCOME=rolled_back
        return 1
      fi
      UPGRADE_OUTCOME=applied
      return 0
    fi
    err "$(t self_update_failed)"
    [ -n "$SELF_UPDATE_REASON" ] && err "$(t "$SELF_UPDATE_REASON")"
    if ! ui_confirm "$(t ask_image_only)" n; then
      # .env 到这里还没被这次调用改过，不需要回滚——nothing was written
      UPGRADE_OUTCOME=rolled_back
      return 1
    fi
    # 同意仅升级镜像：脚本版本保持不变，直接在本进程内继续下面的镜像切换逻辑
  fi

  # 镜像名与版本号在这里一起写：要么都成功、要么都不改——不存在只改了一个的中间态
  if [ "$from_local" = 1 ] && [ -n "$want_image" ]; then
    if ! env_set "$envf" LLAMAPAD_IMAGE "$want_image"; then
      UPGRADE_OUTCOME=rolled_back
      return 1
    fi
  fi
  if ! env_set "$envf" LLAMAPAD_VERSION "$target"; then
    _upgrade_rollback_image "$from_local" "$orig_image"
    UPGRADE_OUTCOME=rolled_back
    return 1
  fi
  if ! template_sync; then
    [ "$target" = "$cur" ] || env_set "$envf" LLAMAPAD_VERSION "$cur"
    template_sync_rollback
    _upgrade_rollback_image "$from_local" "$orig_image"
    UPGRADE_OUTCOME=rolled_back
    return 1
  fi
  if ! compose pull; then
    [ "$target" = "$cur" ] || env_set "$envf" LLAMAPAD_VERSION "$cur"
    template_sync_rollback
    _upgrade_rollback_image "$from_local" "$orig_image"
    err "$(t pull_failed)"
    UPGRADE_OUTCOME=rolled_back
    return 1
  fi
  # pull 已经成功：镜像名与版本号保留新值，重建失败也不回滚（与既有 Hub 升级重建失败
  # 不回滚版本号的行为一致），只提示排查后手动 llamapad start
  if ! cmd_restart; then
    [ "$from_local" = 1 ] && warn "$(t upgrade_restart_failed "$want_image:$target")"
    UPGRADE_OUTCOME=restart_failed
    return 1
  fi
  UPGRADE_OUTCOME=applied
  return 0
}

# 当前在用本地镜像时先问怎么升级：从仓库重建 / 切回 Hub 正式版 / 取消。
# 第二阶段（自更新 exec 过来）从 LLAMAPAD_UPGRADE_REVERT_IMAGE 直接拿到原镜像名，不用
# 再问一遍菜单——这个变量只信一次：要求 LLAMAPAD_UPGRADE_STAGE=2 同时成立，读到后立即
# unset，防止它单独残留在同一 shell 里，把下一次本不相关的 cmd_upgrade 调用误判成第二阶段
cmd_upgrade() {
  local envf="$LP_HOME/.env" opts=() acts=() from_local=0 saved_image="" want_image=""
  # 在任何提前 return（菜单取消、走 cmd_build）之前清空，不残留上一次调用的结果
  UPGRADE_OUTCOME=""
  if [ "${LLAMAPAD_UPGRADE_STAGE:-}" = 2 ] && [ -n "${LLAMAPAD_UPGRADE_REVERT_IMAGE:-}" ]; then
    # 第一阶段没有写 .env 的镜像名（只导出了原镜像名，供失败时回滚用）；第二阶段自己
    # 认下要切到的目标就是 Hub 镜像——本地镜像切回 Hub 就只有这一个目的地
    from_local=1
    saved_image="$LLAMAPAD_UPGRADE_REVERT_IMAGE"
    want_image="$LLAMAPAD_HUB_IMAGE"
    unset LLAMAPAD_UPGRADE_REVERT_IMAGE
  elif ! image_is_hub "$envf"; then
    if repo_resolve >/dev/null 2>&1; then
      opts+=("$(t upgrade_rebuild_local)")
      acts+=(rebuild)
    fi
    opts+=("$(t upgrade_switch_hub)")
    acts+=(hub)
    opts+=("$(t upgrade_cancel)")
    acts+=(cancel)
    ui_menu "$(t ask_upgrade_local_image)" "${opts[@]}" || return 0
    case "${acts[$UI_CHOICE]:-cancel}" in
      rebuild) cmd_build; return $? ;;
      hub)
        saved_image=$(env_get "$envf" LLAMAPAD_IMAGE)
        want_image="$LLAMAPAD_HUB_IMAGE"
        from_local=1
        ;;
      *) return 0 ;;
    esac
  fi

  _upgrade_apply "$from_local" "$want_image" "$saved_image"
  case "$UPGRADE_OUTCOME" in
    rolled_back | restart_failed) return 1 ;;
    *) return 0 ;;
  esac
}

# ===== 13. 自检与卸载 =====

# doctor_line ok|warn|fail 信息 [建议]
doctor_line() {
  case "$1" in
    ok) ok "$2" ;;
    warn) warn "$2" ;;
    *) err "$2" ;;
  esac
  if [ -n "${3:-}" ]; then info "    → $3"; fi
  return 0
}

cmd_doctor() {
  local envf="$LP_HOME/.env" fails=0 k v gid cards port owner puid pgid models avail cur recorded ref
  if platform_ok; then
    doctor_line ok "$(t doc_platform_ok "$(uname -s)")"
  else
    doctor_line fail "$(t unsupported_platform)"
    fails=$((fails + 1))
  fi
  if docker_probe; then
    doctor_line ok "$(t doc_docker_ok "$(dk version --format '{{.Server.Version}}' 2>/dev/null)")"
    if [ "$DK_SUDO" = 1 ]; then doctor_line warn "$(t doc_docker_sudo)" "$(t doc_docker_sudo_hint)"; fi
  else
    doctor_line fail "$(docker_probe_message)"
    fails=$((fails + 1))
  fi

  # docker 不可用时 image_local_exists 无从判断（会误报缺失）；.env 没有 LLAMAPAD_VERSION
  # 时 image_ref 拼出的引用本就不完整——两种情况都跳过这项检查，不计入失败、不误导用户
  if [ "$DK_STATE" = ok ] && [ -n "$(env_get "$envf" LLAMAPAD_VERSION)" ]; then
    ref="$(image_ref "$envf")"
    if image_local_exists "$ref"; then
      doctor_line ok "$(t doc_image_ok "$ref")"
    elif image_is_hub "$envf"; then
      doctor_line warn "$(t doc_image_pull_needed "$ref")"
    else
      doctor_line fail "$(t doc_image_missing "$ref")" "$(t doc_image_build_hint)"
      fails=$((fails + 1))
    fi
  fi

  for k in LLAMAPAD_VERSION PANEL_ADMIN_PASSWORD DOCKER_GID; do
    v=$(env_get "$envf" "$k")
    if [ -z "$v" ]; then
      doctor_line fail "$(t doc_env_missing_key "$k")" "$(t doc_env_missing_hint)"
      fails=$((fails + 1))
    fi
  done

  gid=$(detect_docker_gid)
  v=$(env_get "$envf" DOCKER_GID)
  if [ -n "$gid" ] && [ -n "$v" ] && [ "$gid" != "$v" ]; then
    doctor_line warn "$(t doc_gid_mismatch "$v" "$gid")" "$(t doc_gid_hint)"
  elif [ -n "$gid" ] && [ -n "$v" ]; then
    doctor_line ok "$(t doc_gid_ok "$gid")"
  fi

  cards=$(gpu_cards)
  if env_gpu_on "$envf"; then
    if [ "$DK_STATE" = ok ] && gpu_runtime_ok; then
      doctor_line ok "$(t doc_gpu_ok)"
    else
      doctor_line fail "$(t gpu_runtime_missing)"
      fails=$((fails + 1))
    fi
  elif [ -n "$cards" ]; then
    doctor_line warn "$(t doc_gpu_available_disabled)" "$(t doc_gpu_enable_hint)"
  else
    doctor_line ok "$(t doc_gpu_off)"
  fi

  port=$(env_get "$envf" PANEL_PORT)
  port="${port:-$LLAMAPAD_DEFAULT_PORT}"
  if [ "$DK_STATE" = ok ] && panel_running; then
    doctor_line ok "$(t doc_port_panel "$port")"
  elif port_in_use "$port"; then
    doctor_line fail "$(t port_busy "$port")" "$(t doc_port_hint)"
    fails=$((fails + 1))
  else
    doctor_line ok "$(t doc_port_free "$port")"
  fi

  puid=$(env_get "$envf" PUID)
  pgid=$(env_get "$envf" PGID)
  owner=$(stat_owner "$LP_HOME/data")
  if [ "$owner" = "${puid:-1000}:${pgid:-1000}" ]; then
    doctor_line ok "$(t doc_owner_ok "$owner")"
  else
    doctor_line fail "$(t data_owner_mismatch "$owner" "${puid:-1000}:${pgid:-1000}")" "$(t doc_owner_hint)"
    fails=$((fails + 1))
  fi

  models=$(models_abs "$(env_get "$envf" MODELS_DIR)")
  if [ ! -d "$models" ]; then
    doctor_line fail "$(t models_missing "$models")"
    fails=$((fails + 1))
  else
    avail=$(df_avail_kb "$models")
    if [ "${avail:-0}" -lt "$LLAMAPAD_MIN_FREE_KB" ]; then
      doctor_line warn "$(t doc_models_low "$models" "$(fmt_kb "${avail:-0}")")"
    else
      doctor_line ok "$(t doc_models_ok "$models" "$(fmt_kb "$avail")")"
    fi
  fi

  cur=$(sha256_file "$LP_HOME/docker-compose.yml" 2>/dev/null)
  recorded=$(state_get compose_sha256)
  if [ -n "$recorded" ] && [ "$cur" != "$recorded" ]; then
    doctor_line warn "$(t doc_compose_modified)"
  fi

  if [ "$fails" = 0 ]; then
    ok "$(t doc_all_good)"
    return 0
  fi
  err "$(t doc_has_failures "$fails")"
  return 1
}

# 只删确实是 llamapad 安装目录（有 state 文件）且不是系统目录的路径
safe_remove_home() {
  if path_forbidden "$LP_HOME"; then
    err "$(t refuse_delete "$LP_HOME")"
    return 1
  fi
  if [ ! -f "$LP_HOME/.llamapad-state" ]; then
    err "$(t refuse_delete "$LP_HOME")"
    return 1
  fi
  rm -rf "$LP_HOME" 2>/dev/null || as_root rm -rf "$LP_HOME"
  if [ ! -e "$LP_HOME" ]; then
    ok "$(t home_deleted "$LP_HOME")"
  fi
}

# uninstall_foreign_entries：安装目录下顶层条目里，不属于 llamapad 自身产物的那些
# （已知集合按脚本实际会写出的文件/目录核对；env_set/state_set 的残留临时文件前缀
# .env.tmp.*、.llamapad-state.tmp.* 直接跳过，不当已知项也不当无关项列出——它们本就是
# 应该被静默清理的运行期垃圾，不是用户需要知晓的「不属于 llamapad 的内容」）
uninstall_foreign_entries() {
  local e base known k models_dir models_top=""
  models_dir=$(models_abs "$(env_get "$LP_HOME/.env" MODELS_DIR)")
  case "$models_dir" in
    "$LP_HOME"/*)
      models_top="${models_dir#"$LP_HOME"/}"
      models_top="${models_top%%/*}"
      ;;
  esac
  for e in "$LP_HOME"/* "$LP_HOME"/.[!.]*; do
    [ -e "$e" ] || [ -L "$e" ] || continue
    base=$(basename "$e")
    case "$base" in .env.tmp.* | .llamapad-state.tmp.*) continue ;; esac
    known=0
    for k in data backups "$models_top" .env docker-compose.yml docker-compose.gpu.yml \
      .llamapad-state llamapad.sh .llamapad.sh.new .llamapad.sh.tmp .llamapad-launcher.tmp \
      .docker-compose.yml.new .docker-compose.gpu.yml.new; do
      [ -n "$k" ] && [ "$base" = "$k" ] && { known=1; break; }
    done
    [ "$known" = 1 ] || printf '%s\n' "$base"
  done
}

cmd_uninstall() {
  local launcher="$LP_BIN_DIR/llamapad" models name foreign
  ui_confirm "$(t ask_uninstall)" n || return 1
  compose down || warn "$(t compose_down_failed)"
  if [ -f "$launcher" ] && grep -qF "$(sh_quote "$LP_HOME/llamapad.sh")" "$launcher"; then
    if rm -f "$launcher" 2>/dev/null || as_root rm -f "$launcher"; then
      ok "$(t launcher_removed "$launcher")"
    fi
  fi
  info "$(t uninstall_kept "$LP_HOME")"
  ui_confirm "$(t ask_delete_home)" n || return 0
  models=$(models_abs "$(env_get "$LP_HOME/.env" MODELS_DIR)")
  case "$models" in
    "$LP_HOME"/*) warn "$(t delete_home_includes_models "$models")" ;;
    *) info "$(t models_outside_kept "$models")" ;;
  esac
  foreign=$(uninstall_foreign_entries)
  if [ -n "$foreign" ]; then
    warn "$(t uninstall_foreign_files)"
    printf '%s\n' "$foreign" | sed 's/^/    /' >&2
  fi
  name=$(basename "$LP_HOME")
  ui_input "$(t type_dir_name "$name")" "" || return 0
  if [ "$UI_VALUE" != "$name" ]; then
    info "$(t delete_aborted)"
    return 0
  fi
  safe_remove_home
}

# ===== 14. 入口 =====

cmd_help() {
  local c
  t usage
  printf '\n\n%s\n' "$(t help_commands_title)"
  for c in install start stop restart status logs config upgrade build doctor uninstall help version; do
    printf '  %-10s %s\n' "$c" "$(t "help_$c")"
  done
  printf '\n%s\n' "$(t help_options_title)"
  printf '  %-16s %s\n' \
    "--dir DIR" "$(t help_opt_dir)" \
    "--lang zh|en" "$(t help_opt_lang)" \
    "--to VERSION" "$(t help_opt_to)" \
    "--repo DIR" "$(t help_opt_repo)" \
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
      --repo) OPT_REPO="${2:-}"; shift ;;
      --repo=*) OPT_REPO="${1#--repo=}" ;;
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

# 管理模式（菜单与所有管理命令）前置检查：安装目录必须可写，其中的 .env 若存在必须可读可写——
# 否则大概率是别的用户（sudo 装的、或别的 uid）在管理这份部署，贸然继续要么改不动、要么写出
# 当前用户能读但目标进程读不到的文件，不如直接提示换用 sudo
home_access_ok() {
  [ -w "$LP_HOME" ] || return 1
  [ -f "$LP_HOME/.env" ] || return 0
  [ -r "$LP_HOME/.env" ] && [ -w "$LP_HOME/.env" ]
}

main() {
  local home
  parse_args "$@" || exit 2
  detect_lang
  case "$CMD" in
    help) cmd_help; return 0 ;;
    version) printf '%s\n' "$LLAMAPAD_SCRIPT_VERSION"; return 0 ;;
  esac
  trap ui_restore EXIT
  trap 'ui_restore; exit 130' INT TERM

  home=$(home_candidate)
  if [ -n "$home" ] && [ "$(dir_state "$home")" = installed ]; then
    LP_HOME="$home"
    if ! home_access_ok; then
      err "$(t no_home_permission "$LP_HOME")"
      return 1
    fi
    case "$CMD" in
      "" | install) main_menu ;;
      doctor) cmd_doctor ;;
      start | stop | restart | status | logs | config | upgrade | uninstall | build) require_docker && "cmd_$CMD" ;;
      *) err "$(t unknown_command "$CMD")"; return 2 ;;
    esac
    return
  fi

  case "$CMD" in
    # 默认目录只取显式给出的（--dir / LLAMAPAD_HOME），不取脚本所在目录——在仓库里跑时那是 deploy/
    "" | install) cmd_install "${OPT_DIR:-${LLAMAPAD_HOME:-}}" ;;
    # 构建只依赖仓库与 docker，不依赖安装：在仓库里跑脚本就该能直接构建
    build) require_docker && cmd_build_standalone ;;
    start | stop | restart | status | logs | config | upgrade | doctor | uninstall)
      err "$(t not_installed)"
      return 1
      ;;
    *) err "$(t unknown_command "$CMD")"; return 2 ;;
  esac
}

if [ "${LLAMAPAD_SOURCE_ONLY:-}" != "1" ]; then
  main "$@"
fi
