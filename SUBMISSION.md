# Keepstack 素材检索测评

[Fork](https://github.com/grumpykendal0622/AI-Engineer-Quiz) · [集成分支 `codex/asset-search`](https://github.com/grumpykendal0622/AI-Engineer-Quiz/tree/codex/asset-search) · [验收清单](docs/asset-search-stories.md)

## 本地复现

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

打开 <http://127.0.0.1:8000>，用演示账号 `admin` / `admin` 登录。输入 `harbor`，选择 **Harbor campaign**、**Image**；包含 `approved` 和 `campaign`，排除 `internal` 和 `restricted`。预期 15 条，分页 12 + 3。第二页点 **Export all 15 (CSV)**，得到 15 行数据，顺序与拼接两页相同。

搜索数据生成器包含同创建时间、不同集合和类型、已删除、标签前缀相同及只命中一个排除条件的样本。生成数据不提交。

## 验证结果

- **pytest：** `.venv/bin/python -m pytest -q`。本地 31 通过、2 跳过（无本地 CLIP 模型；本机 Tesseract 缺动态库，测试时用不含该二进制的 `PATH`）。测试自行创建临时数据库，无需手动 seed。
- **GitHub Actions：** 集成代码提交 `7c0b3646e11b722914e917a9e67e4a105cc01502` 的 [CI](https://github.com/grumpykendal0622/AI-Engineer-Quiz/actions/runs/45611518993) 通过。Python 3.10 和 3.12 各 32 通过、1 跳过（CLIP），包含 OCR 测试。[集成分支运行记录](https://github.com/grumpykendal0622/AI-Engineer-Quiz/actions?query=branch%3Acodex%2Fasset-search)可核对文档提交之后的结果。
- **Playwright Chromium：** 用真实表单登录，验证组合筛选、集合切换／返回、分页、乱序响应、失败重试、第二页下载全量 CSV 及零结果表头。验证了下载失败提示，以及从详情保存带中文、引号、逗号、换行的内容后再次查询和导出。回归了导航、上传、原文件下载、分享、删除及管理员退出后用 viewer 登录。

## 取舍与限制

- 关键词保留现有 FTS5 字段和分词，不解析标签语法。包含／排除用独立选择器，先显示常用标签，其余可搜索或展开。选择即时生效，条件可单独清除。只展示真实匹配总数，不展示容易误读的全库标签计数。语义搜索入口隐藏，其余页面保留。
- 列表和 CSV 共享筛选 SQL 和排序。默认按 `created_at DESC, id DESC`，升序使用反向顺序。每页 12 条，不承诺数据变化时的跨请求快照。
- CSV 用 UTF-8 BOM 和标准 CSV 引号转义；`tags` 是按名称排序的 JSON 数组，空标签为 `[]`。字段原样保留；使用电子表格打开不可信元数据时请按文本导入。
- 服务端逐行发送 CSV，浏览器通过认证请求收到 Blob 后下载。未做后台导出、超大文件专项优化或新权限体系。
