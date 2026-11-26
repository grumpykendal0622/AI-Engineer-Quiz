# Keepstack 素材检索测评

[Fork](https://github.com/grumpykendal0622/AI-Engineer-Quiz) · [集成分支 `codex/asset-search`](https://github.com/grumpykendal0622/AI-Engineer-Quiz/tree/codex/asset-search) · [Draft PR](https://github.com/grumpykendal0622/AI-Engineer-Quiz/pull/1) · [验收清单](docs/asset-search-stories.md) · [收尾清单](TODO.md)

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

集合操作可重复验证：在 Collections 新建空集合，打开后批量添加现有素材；从任意素材详情用同一个 **Save changes** 保存元数据、标签和集合关系。删除集合或移出成员不会删除原素材。普通用户的操作权限取决于角色。

## 验证结果

- **pytest：** `.venv/bin/python -m pytest -q`。本地 40 通过、2 跳过（无本地 CLIP 模型；本机 Tesseract 缺动态库，测试时用不含该二进制的 `PATH`）。测试自行创建临时数据库，无需手动 seed。
- **Playwright Chromium：** 4 条自动回归走真实登录表单与浏览器下载，验证搜索和跨页 CSV（包括零结果表头、导出途中换条件）、集合与单次保存（包括最后一页移出、失败保留草稿、Unicode、引号和换行）、角色和会话、上传批次状态及 Audit 刷新。每例用独立数据目录。
- **GitHub Actions：** 集成代码提交 `77bbb72ae9f54e3924d5fc3d6f01f6543db30b84` 的 [CI](https://github.com/grumpykendal0622/AI-Engineer-Quiz/actions/runs/45754622275) 通过：Python 3.10、3.12 各 41 通过、1 跳过（无 CLIP 模型），Chromium 4 通过。浏览器失败时保存截图和 trace。[集成分支运行记录](https://github.com/grumpykendal0622/AI-Engineer-Quiz/actions?query=branch%3Acodex%2Fasset-search)也可核对文档提交后的 CI。

本地复跑浏览器回归（不依赖上面的本地演示服务）：

```bash
.venv/bin/python -m pip install -e '.[dev,e2e]'
.venv/bin/python -m playwright install chromium
KEEPSTACK_E2E_OUTPUT=test-results/browser .venv/bin/python -m pytest -q tests/e2e_workflows.py
```

## 取舍与限制

- 关键词保留现有 FTS5 字段和分词，不解析标签语法。包含／排除用可搜索、可翻页的独立选择器。选择即时生效，条件可单独清除。只展示真实匹配总数，不展示容易误读的全库标签计数。语义搜索入口隐藏，其余页面保留。
- 列表和 CSV 共享筛选 SQL 和排序。默认按 `created_at DESC, id DESC`，升序使用反向顺序。每页 12 条，不承诺数据变化时的跨请求快照。
- CSV 用 UTF-8 BOM 和标准 CSV 引号转义；`tags` 是按名称排序的 JSON 数组，空标签为 `[]`。字段原样保留；使用电子表格打开不可信元数据时请按文本导入。
- 服务端逐行发送 CSV，浏览器通过认证请求收到 Blob 后下载。集成测试验证 207 条可全量导出；未做后台导出或超大文件专项优化。
- 上传每文件上限由 `KEEPSTACK_MAX_UPLOAD_MB` 控制（默认 1024 MiB）。这是应用接收 multipart 后的校验，不代替生产代理的请求体和并发限制。留存日期只存值、不执行自动删除或阻止删除；未引入新权限体系。
