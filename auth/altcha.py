"""ALTCHA 人机验证（Proof-of-Work CAPTCHA）服务端配置与校验.

替代原先自研的「行为分析式」反机器人机制，改用开源的 ALTCHA
（https://github.com/altcha-org/altcha，MIT 协议）：

- 服务端仅负责签发一次性的 HMAC 挑战（/api/altcha/challenge）与校验前端回传的
  base64 凭证（verify_solution_v1），全程纯密码学运算，不依赖任何第三方 API，
  对服务器几乎零负担，非常适合免费实例部署。
- 算力证明（PoW）在浏览器端完成，真人几乎无感，机器人/脚本则需付出大量算力。
"""

from __future__ import annotations

import os

from fastapi import HTTPException, status

from altcha import verify_solution_v1

# HMAC 密钥：用于签发挑战与校验凭证，必须与服务端一致。
# 生产环境（如 Render）请通过环境变量设置一个足够长且随机的字符串。
ALTCHA_HMAC_KEY = os.environ.get(
    "ALTCHA_HMAC_KEY",
    "altcha-dev-insecure-default-key-change-me",
)


def verify_altcha(payload: str | None) -> None:
    """校验前端提交的 ALTCHA payload。

    校验不通过（缺失 / 篡改 / 密钥不符 / 已过期）时直接抛出 400，
    由调用方（登录 / 注册接口）终止请求。

    Args:
        payload: 前端 <altcha-widget> 解出后回传的 base64 凭证。
    """
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="请先完成人机验证",
        )
    ok, reason = verify_solution_v1(payload, ALTCHA_HMAC_KEY, check_expires=True)
    if not ok:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"人机验证失败：{reason or '凭证无效'}",
        )
