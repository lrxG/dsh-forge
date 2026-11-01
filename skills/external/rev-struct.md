---
name: rev-struct
description: Reconstruct data structures by analyzing memory access patterns across functions
whenToUse: 反编译里全是 *(a1+0x10) 这类偏移访问、需要还原结构体布局时
---

# rev-struct - Structure Recovery

Recover data structure definitions by analyzing memory access patterns in functions and their call chains.

## Pre-check

**Determine which IDA access method is available:**

**Option A — IDA Pro MCP (preferred if connected):**
Check if the IDA Pro MCP server is connected (look for an active `ida-pro` or equivalent MCP connection). If connected, you can query IDA directly via MCP tools — no exported files needed. Proceed with the analysis using MCP.

**Option B — IDA-NO-MCP exported data:**
If MCP is not connected, check if IDA-NO-MCP exported data exists in the current directory:

1. Check if `decompile/` directory exists
2. Check if there are `.c` files inside

If neither MCP nor exported data is available, prompt the user:
```
No IDA access method detected. Choose one of the following:

Option A — IDA Pro MCP (recommended):
  Connect the IDA Pro MCP server so DeepSeek Harness can query IDA directly.

Option B — IDA-NO-MCP export:
  1. Download plugin: https://github.com/P4nda0s/IDA-NO-MCP
  2. Copy INP.py to IDA plugins directory
  3. Press Ctrl-Shift-E in IDA to export
  4. Open the exported directory in DeepSeek Harness
```

---

## Export Directory Structure

```
./
├── decompile/              # Decompiled C code directory
│   ├── 0x401000.c          # One file per function, named by hex address
│   ├── 0x401234.c
│   └── ...
├── decompile_failed.txt    # Failed decompilation list
├── decompile_skipped.txt   # Skipped functions list
├── strings.txt             # String table (address, length, type, content)
├── imports.txt             # Import table (address:function_name)
├── exports.txt             # Export table (address:function_name)
└── memory/                 # Memory hexdump (1MB chunks)
```

## Function File Format (decompile/*.c)

Each `.c` file contains function metadata comments and decompiled code:

```c
/*
 * func-name: sub_401000
 * func-address: 0x401000
 * callers: 0x402000, 0x403000    // List of functions that call this function
 * callees: 0x404000, 0x405000    // List of functions called by this function
 */

int __fastcall sub_401000(int a1, int a2)
{
    // Decompiled code...
}
```

---

## Structure Recovery Steps

### Step 1: Read Target Function

1. Based on the user-provided address, read `decompile/<address>.c`
2. Parse function metadata, extract callers and callees lists
3. Identify pointer parameters in the function (potential structure pointers)

### Step 2: Collect Memory Access Patterns

Search for the following patterns in the target function:

**Direct offset access:**
```c
*(a1 + 0x10)           // offset 0x10
*(_DWORD *)(a1 + 8)    // offset 0x8, DWORD type
*(_QWORD *)(a1 + 0x20) // offset 0x20, QWORD type
*(_BYTE *)(a1 + 4)     // offset 0x4, BYTE type
```

**Array access:**
```c
*(a1 + 8 * i)          // array, element size 8 bytes
a1[i]                  // array access
```

**Nested structures:**
```c
*(*a1 + 0x10)          // first field of struct pointed by a1 is a pointer
```

**Record format:**
```
offset=0x00, size=8, access=read/write, type=QWORD
offset=0x08, size=4, access=read, type=DWORD
...
```

### Step 3: Traverse Callers for Analysis

Read each caller function and analyze:

1. **Parameter passing**: What is passed when calling?
   ```c
   sub_401000(v1);        // v1 might be a struct pointer
   sub_401000(&v2);       // v2 is a struct
   sub_401000(malloc(64)); // struct size is ~64 bytes
   ```

2. **Operations before/after the call**: 
   ```c
   v1 = malloc(0x40);     // allocate 0x40 bytes
   *v1 = 0;               // offset 0x00 initialization
   *(v1 + 8) = callback;  // offset 0x08 is a function pointer
   sub_401000(v1);
   ```

3. **Collect more offset accesses**

### Step 4: Traverse Callees for Analysis

Read each callee function and analyze:

1. **How parameters are used**:
   ```c
   // In callee
   int callee(void *a1) {
       return *(a1 + 0x18);  // accesses offset 0x18
   }
   ```

2. **Passed to other functions**:
   ```c
   another_func(a1 + 0x20);  // offset 0x20 might be a nested struct
   ```

### Step 5: Aggregate and Infer

1. **Merge all offset information**, sort by offset
2. **Calculate struct size**: max(offset) + last_field_size
3. **Infer field types**:
   - Called as function pointer → function pointer
   - Passed to `strlen`/`printf` → string pointer
   - Compared with constants → enum/flags
   - Increment/decrement operations → counter/index
4. **Identify common patterns**:
   - Offset 0 is a function pointer table → vtable (C++ object)
   - next/prev pointers → linked list node
   - refcount field → reference counted object

---

## 判据：结构还原到什么程度算成立

- 同一偏移在**多个调用者**里以相同类型被读写，才算真实字段；单函数里的一次偏移可能只是临时指针运算。
- 偏移对得上不等于同一结构——不同结构可以有相同布局，要靠调用关系与字段语义区分。
- 数组元素大小推错会让其后所有偏移错位，先定元素大小再展开。
- 编译器会复用字段（union/重叠），布局可能有两种解释；这时写"两种解释"，不硬定一个。
- **换路**：目标函数在 `decompile_failed` 里、或调用者少于两个，就先别下结论，转汇编或动态观测。

## Output Format

```c
/*
 * Structure Recovery Analysis
 * Source function: <func_address>
 * Analysis scope: <number of callers/callees analyzed>
 * 
 * Functions using this struct:
 *   - 0x401000 (initialization)
 *   - 0x401100 (field access)
 *   - 0x401200 (destruction)
 */

// Estimated size: 0x48 bytes
// Confidence: High / Medium / Low

struct suggested_name {
    /* 0x00 */ void *vtable;           // vtable pointer, called: (*(*this))()
    /* 0x08 */ int refcount;           // reference count, has ++/-- operations
    /* 0x0C */ int flags;              // flags, AND with 0x1, 0x2
    /* 0x10 */ char *name;             // string, passed to strlen/printf
    /* 0x18 */ void *data;             // data pointer
    /* 0x20 */ size_t size;            // size field
    /* 0x28 */ struct node *next;      // linked list next pointer
    /* 0x30 */ struct node *prev;      // linked list prev pointer
    /* 0x38 */ callback_fn handler;    // callback function
    /* 0x40 */ void *user_data;        // user data
};

// Field access examples:
// 0x401000: *(this + 0x08) += 1;     // refcount++
// 0x401100: printf("%s", *(this + 0x10));  // print name
```
