# 用户认证系统功能测试报告

## 1. 测试概述

- **测试时间**：2026-07-10
- **测试环境**：macOS，Python 3.9.6
- **测试框架**：pytest 8.4.2
- **测试范围**：注册、登录、管理员预设、角色权限控制、安全防护

## 2. 测试执行结果

```text
============================= test session starts ==============================
platform darwin -- Python 3.9.6, pytest-8.4.2, pluggy-1.6.0
collected 22 items

tests/test_auth.py::TestRegister::test_register_success PASSED
tests/test_auth.py::TestRegister::test_register_duplicate_username PASSED
tests/test_auth.py::TestRegister::test_register_validation[payload0-422] PASSED
tests/test_auth.py::TestRegister::test_register_validation[payload1-422] PASSED
tests/test_auth.py::TestRegister::test_register_validation[payload2-422] PASSED
tests/test_auth.py::TestRegister::test_register_validation[payload3-422] PASSED
tests/test_auth.py::TestRegister::test_register_validation[payload4-422] PASSED
tests/test_auth.py::TestRegister::test_register_validation[payload5-422] PASSED
tests/test_auth.py::TestRegister::test_register_validation[payload6-422] PASSED
tests/test_auth.py::TestLogin::test_login_success PASSED
tests/test_auth.py::TestLogin::test_login_wrong_password PASSED
tests/test_auth.py::TestLogin::test_login_nonexistent_user PASSED
tests/test_auth.py::TestAdminAccount::test_admin_login PASSED
tests/test_auth.py::TestAdminAccount::test_admin_password_hashed PASSED
tests/test_auth.py::TestAuthorization::test_read_current_user PASSED
tests/test_auth.py::TestAuthorization::test_read_current_user_without_token PASSED
tests/test_auth.py::TestAuthorization::test_normal_user_cannot_access_admin_route PASSED
tests/test_auth.py::TestAuthorization::test_admin_can_access_admin_route PASSED
tests/test_auth.py::TestAuthorization::test_file_management_requires_admin PASSED
tests/test_auth.py::TestSecurity::test_sql_injection_prevention PASSED
tests/test_auth.py::TestSecurity::test_xss_prevention PASSED
tests/test_auth.py::TestSecurity::test_password_not_returned PASSED

============================== 22 passed in 6.91s ==============================
```

**测试结果**：全部 22 个测试用例通过，通过率 100%。

## 3. 测试用例详情

### 3.1 注册功能测试

| 用例编号 | 用例名称                 | 输入                                       | 预期结果        | 实际结果 | 状态 |
|----------|--------------------------|--------------------------------------------|-----------------|----------|------|
| REG-01   | 正常注册                 | 用户名 `newuser`，密码 `secure123`          | 201，返回用户信息 | 通过     | 通过 |
| REG-02   | 重复用户名               | 用户名 `testuser`（已存在）                 | 409，提示已注册  | 通过     | 通过 |
| REG-03   | 用户名过短               | 用户名 `ab`                                | 422             | 通过     | 通过 |
| REG-04   | 用户名含空格             | 用户名 `user name`                         | 422             | 通过     | 通过 |
| REG-05   | XSS 攻击尝试             | 用户名 `<script>alert(1)</script>`         | 422             | 通过     | 通过 |
| REG-06   | SQL 注入尝试             | 用户名 `user' OR '1'='1`                   | 422             | 通过     | 通过 |
| REG-07   | 密码过短                 | 密码 `12345`                               | 422             | 通过     | 通过 |
| REG-08   | 缺少密码                 | 仅提供用户名                                | 422             | 通过     | 通过 |
| REG-09   | 缺少用户名               | 仅提供密码                                  | 422             | 通过     | 通过 |

### 3.2 登录功能测试

| 用例编号 | 用例名称         | 输入                                    | 预期结果        | 实际结果 | 状态 |
|----------|------------------|-----------------------------------------|-----------------|----------|------|
| LOG-01   | 正常登录         | 用户名 `testuser`，密码 `testpass123`    | 200，返回 Token | 通过     | 通过 |
| LOG-02   | 密码错误         | 用户名 `testuser`，密码 `wrongpass`      | 401             | 通过     | 通过 |
| LOG-03   | 用户不存在       | 用户名 `notexist`                        | 401             | 通过     | 通过 |

### 3.3 管理员账户预设测试

| 用例编号 | 用例名称           | 输入                                         | 预期结果                   | 实际结果 | 状态 |
|----------|--------------------|----------------------------------------------|----------------------------|----------|------|
| ADM-01   | 管理员登录         | 用户名 `Glaive`，密码 `19866179818`          | 200，返回 Token             | 通过     | 通过 |
| ADM-02   | 管理员密码加密存储 | 检查数据库中 `Glaive` 的 `hashed_password`   | 不等于明文，可正确校验       | 通过     | 通过 |

### 3.4 角色权限控制测试

| 用例编号 | 用例名称                     | 输入                                              | 预期结果 | 实际结果 | 状态 |
|----------|------------------------------|---------------------------------------------------|----------|----------|------|
| AUTH-01  | 获取当前用户信息             | 携带有效 Token 访问 `/auth/me`                    | 200      | 通过     | 通过 |
| AUTH-02  | 未认证访问受保护接口         | 不带 Token 访问 `/auth/me`                        | 401      | 通过     | 通过 |
| AUTH-03  | 普通用户访问管理员接口       | 普通用户 Token 访问 `/auth/admin-only`            | 403      | 通过     | 通过 |
| AUTH-04  | 管理员访问管理员接口         | 管理员 Token 访问 `/auth/admin-only`              | 200      | 通过     | 通过 |
| AUTH-05  | 普通用户访问文件管理接口     | 普通用户 Token 访问 `/api/series`                 | 403      | 通过     | 通过 |

### 3.5 安全性测试

| 用例编号 | 用例名称         | 输入                                              | 预期结果 | 实际结果 | 状态 |
|----------|------------------|---------------------------------------------------|----------|----------|------|
| SEC-01   | SQL 注入拦截     | 多种 SQL 注入 payload 尝试注册                    | 422      | 通过     | 通过 |
| SEC-02   | XSS 攻击拦截     | `<script>alert(1)</script>` 作为用户名注册        | 422      | 通过     | 通过 |
| SEC-03   | 密码不泄露       | 检查所有接口响应中是否包含密码或哈希               | 不包含   | 通过     | 通过 |

## 4. 测试结论

本次测试覆盖了用户认证系统的核心功能模块与安全场景，所有 22 个测试用例均通过。系统在以下方面表现符合预期：

- 用户注册与登录流程正常；
- 管理员账号 `Glaive` 预设成功，密码以 bcrypt 哈希形式存储；
- 基于 JWT 的身份认证与基于角色的权限控制工作正常；
- 输入校验可有效拦截 SQL 注入与 XSS 攻击尝试；
- 接口响应中不会泄露用户密码或哈希值。

系统已达到可交付状态。
