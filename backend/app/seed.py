# seed.py — CLI 预置用户 + 邀请码
# 功能：python -m app.seed --users alice,bob,carol [--count-per-user 3]
#       为每个用户创建（已存在则跳过）并生成邀请码，打印到控制台。
# 依赖：argparse、db、models
# 可调参数：--users 用户列表、--count-per-user 每人生成邀请码数量（默认 3）
import argparse
import secrets

from .db import SessionLocal, init_db
from .models import InviteCode, User


def make_invite_code() -> str:
    """功能：生成形如 ACM-XXXX 的邀请码（大写字母+数字，字符集去掉易混淆字符）。
    API: make_invite_code() → str
    依赖：secrets。可调参数：无。"""
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "ACM-" + "".join(secrets.choice(alphabet) for _ in range(4))


def seed(users: list[str], count_per_user: int = 3) -> None:
    """功能：创建用户并生成邀请码，返回码列表（未入库提交）。
    API: seed(list[str], int=3) → list[(username, code)]
    依赖：db/models。可调参数：count_per_user。"""
    init_db()
    db = SessionLocal()
    results = []
    try:
        for name in users:
            name = name.strip()
            user = db.query(User).filter(User.username == name).first()
            if user is None:
                user = User(username=name, display_name=name)
                db.add(user)
                db.flush()
            for _ in range(count_per_user):
                code = make_invite_code()
                db.add(InviteCode(code=code, user_id=user.id))
                results.append((name, code))
        db.commit()
    finally:
        db.close()
    return results


def main() -> None:
    """功能：CLI 入口（python -m app.seed --users ...）。
    API: main() → None
    依赖：argparse、seed。可调参数：见命令行参数。"""
    parser = argparse.ArgumentParser(description="预置用户与邀请码")
    parser.add_argument("--users", required=True, help="逗号分隔的用户名列表，如 alice,bob,carol")
    parser.add_argument("--count-per-user", type=int, default=3, help="每人生成邀请码数量（默认 3）")
    args = parser.parse_args()
    users = [u for u in args.users.split(",") if u.strip()]
    if not users:
        parser.error("--users 不能为空")
    for username, code in seed(users, args.count_per_user):
        print(f"{username}: {code}")


if __name__ == "__main__":
    main()
