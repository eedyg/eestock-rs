#!/usr/bin/env bash
# entangled_patterns.sh — watch_list 通配符匹配（供 check-tangle.sh / stitch.sh 共用）
#
# entangled 的 watch_list 用 `**` 匹配"零个或多个目录"（globstar 语义）：
#   design/**/*.md 命中 design/00-vision.md 与 design/06-web/01-dashboard.md
# bash 的 `[[ $path == $glob ]]` 做不到零目录匹配（`**` 退化成普通 `*`，中间的 `/` 变字面量），
# 因此这里把 glob 转成正则再匹配。
#
# 用法： source .../lib/entangled_patterns.sh ; path_matches "design/a.md" 'design/**/*.md'
path_matches() { # $1=路径 $2=glob；命中返回 0
    local path="$1" glob="$2" re="" i=0 n=${#2} c nxt nxt2
    n=${#glob}
    while [ "$i" -lt "$n" ]; do
        c="${glob:$i:1}"
        case "$c" in
            '*')
                nxt="${glob:$((i + 1)):1}"
                nxt2="${glob:$((i + 2)):1}"
                if [ "$nxt" = "*" ]; then
                    if [ "$nxt2" = "/" ]; then
                        re+="(.*/)?"
                        i=$((i + 3))
                    else
                        re+=".*"
                        i=$((i + 2))
                    fi
                else
                    re+="[^/]*"
                    i=$((i + 1))
                fi
                ;;
            '?')
                re+="[^/]"
                i=$((i + 1))
                ;;
            '.' | '+' | '(' | ')' | '[' | ']' | '{' | '}' | '^' | '$' | '|' | '\\')
                re+="\\$c"
                i=$((i + 1))
                ;;
            *)
                re+="$c"
                i=$((i + 1))
                ;;
        esac
    done
    [[ "$path" =~ ^${re}$ ]]
}
