# Keepstack 素材检索测评

[Fork](https://github.com/grumpykendal0622/AI-Engineer-Quiz) · [集成分支 `codex/asset-search`](https://github.com/grumpykendal0622/AI-Engineer-Quiz/tree/codex/asset-search) · [Draft PR](https://github.com/grumpykendal0622/AI-Engineer-Quiz/pull/1) · [验收清单](docs/asset-search-stories.md) · [收尾清单](TODO.md)

本题交付一条内容运营流程。在 Library 组合关键词、集合、类型和标签，按创建时间浏览，再导出全部匹配行。编辑标题、描述、标签或成员关系后，下一次查询和导出读到新数据。基线为 `3aa137c`。

## 运行与验证

在仓库根目录运行，需 Python 3.10+。使用新的数据目录，不要覆盖现有素材库。

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[dev]'
export KEEPSTACK_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/keepstack-review.XXXXXX")"
export KEEPSTACK_OCR_ENABLED=false KEEPSTACK_AI_ENABLED=false
export KEEPSTACK_HOST=127.0.0.1 KEEPSTACK_PORT=8000 KEEPSTACK_BASE_URL=http://127.0.0.1:8000
.venv/bin/python -m keepstack seed
.venv/bin/python -m keepstack.seed_search
.venv/bin/python -m keepstack
```

打开 <http://127.0.0.1:8000>。在 Library 搜 `harbor`，用 **Collection** 搜选 **Harbor campaign**，类型选 **Image**。包含 `approved` 和 `campaign`，排除 `internal` 和 `restricted`。预期 15 条，分页 12 + 3。第二页点 **Export all 15 (CSV)**，文件有 15 行数据，顺序与拼接两页一致。

集合可新建、添加可选描述、浏览、增减成员和删除。详情里标签、元数据和成员关系一起点 **Save changes**；删除集合或移出成员会保留原素材。返回 Library 后，集合选择、筛选结果和 CSV 反映相应变更。

以下是 seed 生成的本地演示账号。点 **Sign out** 后在同一表单换账号，右上角会显示实际角色。

| 角色 | 用户名 | 密码 |
| --- | --- | --- |
| Admin | `admin` | `admin` |
| Editor | `curator` | `demo1234` |
| Contributor | `contributor` | `demo1234` |
| Viewer | `viewer` | `demo1234` |

## 实测结果

本地 pytest 41 通过、2 跳过（无 CLIP 模型，本机 Tesseract 缺动态库），Chromium 9 通过。验证了同时间戳翻页、旧响应晚到、CSV 中文和特殊字符往返及零结果表头、集合成员变化后列表与导出同步、上传中断后单文件重试。演示服务 `8011` 实测四个角色登录、筛选和退出。

集成代码提交 `573d2f8bcc911ada3f7c74f7b33b64b235da8584` 的 CI 通过。Python 3.10／3.12 各 42 通过、1 跳过（缺 CLIP 模型），Chromium 9 通过。[代码 CI](https://github.com/grumpykendal0622/AI-Engineer-Quiz/actions/runs/45768429062) · [集成分支运行记录](https://github.com/grumpykendal0622/AI-Engineer-Quiz/actions?query=branch%3Acodex%2Fasset-search)

[集合选择器](docs/screenshots/quiz-collection-picker.jpg) · [第二页与全量导出](docs/screenshots/quiz-library-export.jpg) · [集合描述和成员](docs/screenshots/quiz-collection-members.jpg) · [上传中断与 Retry](docs/screenshots/quiz-upload-retry.jpg)

测试使用独立临时数据，无需启动演示服务或手动 seed。

```bash
.venv/bin/python -m pytest -q
.venv/bin/python -m pip install -e '.[dev,e2e]'
.venv/bin/python -m playwright install chromium
KEEPSTACK_E2E_OUTPUT=test-results/browser .venv/bin/python -m pytest -q tests/e2e_workflows.py
```

## 主要取舍

- **侧栏与集合。** Library 是唯一的筛选和 CSV 入口。侧栏 Collections 专注建集合、看成员、编辑描述和增减成员。Library 的集合选择器与标签共用搜索和分页，但按题目规则只选一个集合。原侧栏 Top Tags 和 Media Type 快捷入口并入 Library，避免在管理页点击时难以判断作用范围。保留 Dashboard、Users、Audit log 的 admin 入口。
- **筛选与导出。** 保留 FTS5 字段和分词，只查 `active` 素材。包含项须全部命中，排除项命中任一即排除。侧栏筛选计数取消，标题显示匹配总量。列表和 CSV 共享查询条件与排序，以 ID 打破同时间戳并列。每页 12 条，CSV 包含全部匹配行的元数据。CSV 用 UTF-8 BOM，`tags` 是按名称排序的 JSON 数组，无标签时为 `[]`。
- **编辑与同步。** 同一个详情表单提交元数据、标签和成员关系；失败保留草稿。集合编辑完成后刷新当前应用的数据。集合管理与 Library 的搜索状态独立。

## 限制与未完成项

- **上传。** 图片和其他素材共用默认 1024 MiB 的单文件上限，可用 `KEEPSTACK_MAX_UPLOAD_MB` 调整。拒绝空文件和损坏的光栅图。支持文档（如 CSV）、视频、音频等素材，预览能力因格式而异。按文件内容去重。中断后当前文件可 Retry，已成功文件保留，批次继续。无断点续传。
- **数据规模。** 已测试导出 207 条。浏览器下载前会缓冲 CSV。数据不变时保证分页和导出一致，无跨请求快照或跨客户端实时同步。
- **已知辅助场景。** 列表失败可 Retry，CSV 失败有提示，保存失败保留草稿。模拟详情元数据 500 时，抽屉停在 Loading。模拟分享、删除素材、Users 或 Dashboard 失败时，页面框架仍在，相关操作缺明确反馈。另有 viewer 空库提示引用隐藏的 Upload。已记入 [收尾清单](TODO.md)。
- **题目范围外。** 语义搜索和模型优化、后台导出、新权限体系、在线部署、留存自动执行。保留既有 Similar assets，留存日期只存值。
