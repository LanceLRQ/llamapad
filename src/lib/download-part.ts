/**
 * 下载器断点续传文件的后缀（server/download/downloader.ts 落盘用）。单独
 * 成一份零依赖文件，而不是挂在 repo-files-scan.ts 上：那边下沉的是「档案
 * 详情页 local/strays 计算」，下载器只是恰好也要认出这两个后缀来过滤
 * 半成品——两边都是「我需要 .part 的定义」的消费方，不该有一个方向读成
 * 「下载器要 import 页面扫描模块」。
 */
export const PART_SUFFIX = ".part";
export const PART_META_SUFFIX = ".part.meta.json";
