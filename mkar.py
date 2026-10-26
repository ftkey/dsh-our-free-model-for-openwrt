#!/usr/bin/env python3
"""手工构造 ar 归档（ipk 容器）。

macOS 自带的 bsdtar/ar 会写入 __.SYMDEF 索引并改写成员顺序，
opkg 会拒绝。这里按经典 ar 格式逐成员拼接：
  "!<arch>\n" + 每成员 60 字节头 + 数据（偶数长度补 \n）。
"""
import sys

def ar_member(name: str, data: bytes) -> bytes:
    # ar 成员头：name[16] mtime[12] uid[6] gid[6] mode[8] size[10] `\x60\n`
    n = (name + "/").ljust(16)
    if len(n) > 16:
        raise ValueError("ar member name too long")
    hdr = (
        n.encode()
        + b"0".ljust(12)      # mtime（opkg 不校验）
        + b"0".ljust(6)       # uid
        + b"0".ljust(6)       # gid
        + b"644".ljust(8)     # mode
        + str(len(data)).encode().ljust(10)
        + b"`\n"
    )
    assert len(hdr) == 60
    pad = b"\n" if len(data) % 2 else b""
    return hdr + data + pad

def build(output: str, members: list):
    out = b"!<arch>\n"
    for name, path in members:
        with open(path, "rb") as f:
            out += ar_member(name, f.read())
    with open(output, "wb") as f:
        f.write(out)
    print(f"ar -> {output} ({len(out)/1024/1024:.1f} MB)")

if __name__ == "__main__":
    out = sys.argv[1]
    members = [(sys.argv[2 + i * 2], sys.argv[3 + i * 2]) for i in range((len(sys.argv) - 2) // 2)]
    build(out, members)
