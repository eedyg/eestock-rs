# 资源纪律证据（本波）

## 每步 free -h（观测点：起测 / 单测 / 构建+真渲染 / 收尾）
```
               total        used        free      shared  buff/cache   available
Mem:            46Gi        19Gi       8.8Gi       1.9Gi        20Gi        27Gi
Swap:          8.0Gi       7.3Gi       687Mi

[终测后]
               total        used        free      shared  buff/cache   available
Mem:            46Gi        19Gi       8.8Gi       1.9Gi        20Gi        27Gi
Swap:          8.0Gi       7.3Gi       687Mi
```

## 收尾残留进程（/proc 枚举；★ 先按 comm 排除 bash/sh/python 自查进程，避免自查命令行自匹配）
```
★ 排除 shell 后：vite preview / chromium / playwright 残留匹配数 = 0
```

## 8081 真身仍在线
```
GET / => 200
```
