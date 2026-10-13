@if not defined DEBUG_HELPER @echo off
setlocal enabledelayedexpansion

rem This batch script is a wrapper around the NodeJS JavaScript file
rem entry point with the following bazel label:
rem     {{entry_point_label}}
rem
rem The script was generated to execute the js_binary target
rem     {{target_label}}
rem
rem The template used to generate this script is
rem     {{template_label}}
rem
rem It is the Windows counterpart of js_binary.sh.tpl and is a faithful
rem translation of it: it sets up only what node needs on its command line and
rem leaves the rest of the runtime environment (NODE_WRAPPER, NODE_PATCHES,
rem FS_PATCH_ROOTS, PATH, JS_BINARY__EXECROOT and the user chdir) to the launcher
rem preload (node-bootstrap/launcher.cjs), which it loads via --require. Being
rem self-contained it needs only the .runfiles directory, not a runfiles manifest,
rem so it works inside an OCI image where no manifest is shipped.

set "_exit_code=0"

{{envs}}

set "JS_BINARY__LOG_PREFIX={{log_prefix_rule_set}}[{{log_prefix_rule}}]"

goto :main

rem ==============================================================================
rem Logging helpers
rem ==============================================================================

rem Emit a log line to the capture file in %~1, or to the real stderr when empty. The
rem message is captured by a quoted set, outside any block, and echoed by delayed
rem expansion: a message holding a path such as `C:\Program Files (x86)\...` or an `&`
rem would otherwise be parsed as cmd syntax inside the if/else block below.
:log_to
set "_log_msg=%~3"
if not "%~1"=="" (
    >>"%~1" echo %~2: !JS_BINARY__LOG_PREFIX!: !_log_msg!
) else (
    >&2 echo %~2: !JS_BINARY__LOG_PREFIX!: !_log_msg!
)
exit /b 0

:logf_fatal
if defined JS_BINARY__LOG_FATAL call :log_to "%_log_error_capture%" FATAL "%~1"
exit /b 0

:logf_error
if defined JS_BINARY__LOG_ERROR call :log_to "%_log_error_capture%" ERROR "%~1"
exit /b 0

:logf_info
if defined JS_BINARY__LOG_INFO call :log_to "%STDERR_CAPTURE%" INFO "%~1"
exit /b 0

:logf_debug
if defined JS_BINARY__LOG_DEBUG call :log_to "%STDERR_CAPTURE%" DEBUG "%~1"
exit /b 0

rem ==============================================================================
rem Path resolution helpers
rem ==============================================================================

rem Resolve a capture output path (%~1) to an absolute path in RESULT. A path not
rem under bazel-out\ is relative to the bin directory, so it is joined with
rem BAZEL_BINDIR. Must run before any directory change since it resolves against %CD%.
:resolve_capture_path
set "_cp=%~1"
set "_cp=!_cp:/=\!"
if "!_cp:~1,1!"==":" (
    set "RESULT=!_cp!"
) else if "!_cp:~0,10!"=="bazel-out\" (
    set "RESULT=%CD%\!_cp!"
) else (
    set "RESULT=%CD%\!BAZEL_BINDIR!\!_cp!"
)
exit /b 0

rem Resolve a short_path (%~1) under the bin directory of the execroot into RESULT.
:resolve_execroot_bin_path
set "_bp=%~1"
if "!_bp:~0,3!"=="..\" (
    set "RESULT=!execroot!\!BAZEL_BINDIR!\external\!_bp:~3!"
) else (
    set "RESULT=!execroot!\!BAZEL_BINDIR!\!_bp!"
)
exit /b 0

rem Resolve a short_path (%~1) under the execroot into RESULT.
:resolve_execroot_src_path
set "_sp=%~1"
if "!_sp:~0,3!"=="..\" (
    set "RESULT=!execroot!\external\!_sp:~3!"
) else (
    set "RESULT=!execroot!\!_sp!"
)
exit /b 0

rem Resolve a toolchain file (%~1): an absolute path a user set in node_toolchain, a
rem file in the execroot when there are no runfiles, or a file in the runfiles tree.
:resolve_toolchain_path
set "_tp=%~1"
if "!_tp:~1,1!"==":" (
    set "RESULT=!_tp!"
) else if defined JS_BINARY__NO_RUNFILES (
    call :resolve_execroot_src_path "!_tp!"
) else (
    set "RESULT=!JS_BINARY__RUNFILES!\{{workspace_name}}\!_tp!"
)
exit /b 0

rem Classify a single argument (%~1): a --node_options=<opt> flag is split off into
rem JS_BINARY__NODE_OPTIONS, anything else is appended to the program's ARGS.
:process_arg
set "_arg=%~1"
if not defined _arg exit /b 0
if "!_arg:~0,15!"=="--node_options=" (
    set "JS_BINARY__NODE_OPTIONS=!JS_BINARY__NODE_OPTIONS! !_arg:~15!"
) else (
    set "ARGS=!ARGS! !_arg!"
)
exit /b 0

rem ==============================================================================
rem Mop up and exit
rem ==============================================================================
:cleanup_and_exit
if defined STDERR_CAPTURE_IS_TEMP (
    if !_exit_code! neq 0 (
        type "!STDERR_CAPTURE!" 1>&2
    ) else if not defined _silent_on_success (
        type "!STDERR_CAPTURE!" 1>&2
    )
    del "!STDERR_CAPTURE!" >nul 2>&1
)
if defined STDOUT_CAPTURE_IS_TEMP (
    if !_exit_code! neq 0 (
        type "!STDOUT_CAPTURE!"
    ) else if not defined _silent_on_success (
        type "!STDOUT_CAPTURE!"
    )
    del "!STDOUT_CAPTURE!" >nul 2>&1
)
if defined JS_BINARY__LOG_DEBUG call :logf_debug "exit code: !_exit_code!"
endlocal & exit /b %_exit_code%

:main

rem ==============================================================================
rem Handle --bazel-bindir flag
rem ==============================================================================
rem If a --bazel-bindir <path> flag is passed it must be the first two arguments.
rem It is consumed here to set BAZEL_BINDIR and then dropped from the runtime args.
set "_bazel_bindir_from_flag="
if "%~1"=="--bazel-bindir" (
    if "%~2"=="" (
        >&2 echo ERROR: --bazel-bindir flag requires a value
        set "_exit_code=1"
        goto :cleanup_and_exit
    )
    set "BAZEL_BINDIR=%~2"
    set "_bazel_bindir_from_flag=1"
)

rem Normalize BAZEL_BINDIR to backslashes so it works with cd and path joins.
if defined BAZEL_BINDIR set "BAZEL_BINDIR=!BAZEL_BINDIR:/=\!"

rem ==============================================================================
rem Prepare stdout capture, stderr capture and logging
rem ==============================================================================
rem TODO(4.0): remove support for capturing stderr, stdout, and exit code. The
rem js_run_binary macro now handles this without help from the launcher.

rem Resolve capture output paths to absolute before any directory change.
if defined JS_BINARY__STDOUT_OUTPUT_FILE (
    call :resolve_capture_path "!JS_BINARY__STDOUT_OUTPUT_FILE!"
    set "JS_BINARY__STDOUT_OUTPUT_FILE=!RESULT!"
)
if defined JS_BINARY__STDERR_OUTPUT_FILE (
    call :resolve_capture_path "!JS_BINARY__STDERR_OUTPUT_FILE!"
    set "JS_BINARY__STDERR_OUTPUT_FILE=!RESULT!"
)
if defined JS_BINARY__EXIT_CODE_OUTPUT_FILE (
    call :resolve_capture_path "!JS_BINARY__EXIT_CODE_OUTPUT_FILE!"
    set "JS_BINARY__EXIT_CODE_OUTPUT_FILE=!RESULT!"
)

rem A stream with a declared output file is written straight to it. A stream only
rem subject to silent_on_success is buffered in a temp file and replayed on failure.
if defined JS_BINARY__STDOUT_OUTPUT_FILE (
    set "STDOUT_CAPTURE=!JS_BINARY__STDOUT_OUTPUT_FILE!"
) else if defined JS_BINARY__SILENT_ON_SUCCESS (
    set "STDOUT_CAPTURE=%TEMP%\jsbin_stdout_%RANDOM%%RANDOM%.tmp"
    set "STDOUT_CAPTURE_IS_TEMP=1"
)
if defined JS_BINARY__STDERR_OUTPUT_FILE (
    set "STDERR_CAPTURE=!JS_BINARY__STDERR_OUTPUT_FILE!"
) else if defined JS_BINARY__SILENT_ON_SUCCESS (
    set "STDERR_CAPTURE=%TEMP%\jsbin_stderr_%RANDOM%%RANDOM%.tmp"
    set "STDERR_CAPTURE_IS_TEMP=1"
)

rem FATAL/ERROR diagnostics only go to the stderr capture when it is a temp file that
rem gets replayed on failure; otherwise straight to stderr so they are not lost.
set "_log_error_capture="
if defined STDERR_CAPTURE_IS_TEMP set "_log_error_capture=!STDERR_CAPTURE!"

rem Remember silent_on_success for the cleanup replay before it is de-exported below.
set "_silent_on_success=!JS_BINARY__SILENT_ON_SUCCESS!"

rem ==============================================================================
rem Initialize RUNFILES environment variable
rem ==============================================================================
{{initialize_runfiles}}
set "JS_BINARY__RUNFILES=!RUNFILES!"

rem ==============================================================================
rem Prepare to run main program
rem ==============================================================================

rem The execroot the entry point is resolved against. A parent js_binary hands its own
rem down when it asks for an execroot entry point; otherwise this script was started in
rem it. Nothing else here needs an execroot: the launcher preload works out
rem JS_BINARY__EXECROOT for the program and everything it spawns, so it is not set here.
if defined JS_BINARY__USE_EXECROOT_ENTRY_POINT (
    if defined JS_BINARY__EXECROOT (
        set "execroot=!JS_BINARY__EXECROOT!"
    ) else (
        set "execroot=%CD%"
    )
) else (
    set "execroot=%CD%"
)

rem Build actions are started in the execroot, so change into the root of the Bazel
rem output tree (the bindir), which is where js_binary programs run. It cannot wait for
rem the preload: node resolves the bare specifier of a --require against the directory it
rem was started in. In a runfiles tree, or a nested js_binary already in the bindir,
rem there is nothing to do. The preload tells those apart from the broken case by
rem JS_BINARY__CHANGED_TO_BINDIR.
if not defined JS_BINARY__NO_CD_BINDIR if defined BAZEL_BINDIR if exist "%CD%\!BAZEL_BINDIR!\" (
    call :logf_debug "changing directory to BAZEL_BINDIR (root of Bazel output tree) !BAZEL_BINDIR!"
    set "JS_BINARY__CHANGED_TO_BINDIR=1"
    cd /d "!BAZEL_BINDIR!"
)

if defined JS_BINARY__USE_EXECROOT_ENTRY_POINT if not defined BAZEL_BINDIR (
    call :logf_fatal "Expected BAZEL_BINDIR to be set when JS_BINARY__USE_EXECROOT_ENTRY_POINT is set"
    set "_exit_code=1"
    goto :cleanup_and_exit
)

rem Everything below is resolved here only because node needs it on its command line or
rem cmd needs it to start node at all. The checks that can wait, and the rest of the
rem environment the program sees, are done by the launcher preload once node is up.

if defined JS_BINARY__USE_EXECROOT_ENTRY_POINT (
    call :resolve_execroot_bin_path "{{entry_point_path}}"
    set "entry_point=!RESULT!"
) else if defined JS_BINARY__NO_RUNFILES (
    call :resolve_execroot_bin_path "{{entry_point_path}}"
    set "entry_point=!RESULT!"
) else (
    set "entry_point=!JS_BINARY__RUNFILES!\{{workspace_name}}\{{entry_point_path}}"
)

call :resolve_toolchain_path "{{node}}"
set "JS_BINARY__NODE_BINARY=!RESULT!"
if not exist "!JS_BINARY__NODE_BINARY!" (
    call :logf_fatal "node binary '!JS_BINARY__NODE_BINARY!' not found"
    set "_exit_code=1"
    goto :cleanup_and_exit
)

set "npm={{npm}}"
if defined npm (
    call :resolve_toolchain_path "!npm!"
    set "JS_BINARY__NPM_BINARY=!RESULT!"
)

call :resolve_toolchain_path "{{launcher}}"
set "launcher=!RESULT!"
if not exist "!launcher!" (
    call :logf_fatal "launcher '!launcher!' not found"
    set "_exit_code=1"
    goto :cleanup_and_exit
)

rem Gather node options. Reset first since the var may be inherited from the env.
set "JS_BINARY__NODE_OPTIONS="
{{node_options}}

rem Process command line arguments. Fixed args are baked in at build time and come
rem first, then the runtime args. Both are run through :process_arg so that a
rem --node_options=<opt> in either is split off into JS_BINARY__NODE_OPTIONS.
set "ARGS="
{{fixed_args}}
rem Tokenize the raw command line %* on spaces only. cmd's %1..%9 and `for` set
rem parsers both split each token on '=' too, which would mangle a single runtime arg
rem like `--node_options=--require=<path>`. The raw %* preserves '='. The
rem `set "_rt_arg="` + `if not defined` guard makes the loop terminate rather than
rem spin if `for /f` skips a token.
set "_rt_rest=%*"
if defined _bazel_bindir_from_flag (
    rem Drop the consumed `--bazel-bindir <value>` (first two space-delimited tokens).
    set "_rt_rest="
    for /f "tokens=2* delims= " %%a in ("%*") do set "_rt_rest=%%b"
)
:process_runtime_arg
if not defined _rt_rest goto :process_runtime_args_done
set "_rt_arg="
for /f "tokens=1* delims= " %%a in ("!_rt_rest!") do (
    set "_rt_arg=%%a"
    set "_rt_rest=%%b"
)
if not defined _rt_arg goto :process_runtime_args_done
call :process_arg "!_rt_arg!"
goto :process_runtime_arg
:process_runtime_args_done

rem De-export capture-related vars so children (e.g. a nested js_binary) do not inherit
rem them; they have already been consumed into STDOUT_CAPTURE / STDERR_CAPTURE and
rem _silent_on_success above. _exit_code_output_file keeps the value for the mop up.
set "_exit_code_output_file=!JS_BINARY__EXIT_CODE_OUTPUT_FILE!"
set "JS_BINARY__STDOUT_OUTPUT_FILE="
set "JS_BINARY__STDERR_OUTPUT_FILE="
set "JS_BINARY__EXIT_CODE_OUTPUT_FILE="
set "JS_BINARY__SILENT_ON_SUCCESS="

rem ==============================================================================
rem Run the main program
rem ==============================================================================

rem Invoke node directly rather than through a node wrapper. The wrapper is still put
rem on the PATH as `node` by the launcher preload so that child processes get the
rem patched runtime. Use delayed expansion (!ARGS!, !JS_BINARY__NODE_OPTIONS!) so that
rem parentheses in expanded values are not mis-parsed as cmd block delimiters.
if defined JS_BINARY__LOG_INFO call :logf_info "running !JS_BINARY__NODE_BINARY! --require !launcher! !JS_BINARY__NODE_OPTIONS! -- !entry_point! !ARGS!"

if defined STDOUT_CAPTURE (
    if defined STDERR_CAPTURE (
        "!JS_BINARY__NODE_BINARY!" --require "!launcher!" !JS_BINARY__NODE_OPTIONS! -- "!entry_point!" !ARGS! 1>>"!STDOUT_CAPTURE!" 2>>"!STDERR_CAPTURE!"
    ) else (
        "!JS_BINARY__NODE_BINARY!" --require "!launcher!" !JS_BINARY__NODE_OPTIONS! -- "!entry_point!" !ARGS! 1>>"!STDOUT_CAPTURE!"
    )
) else (
    if defined STDERR_CAPTURE (
        "!JS_BINARY__NODE_BINARY!" --require "!launcher!" !JS_BINARY__NODE_OPTIONS! -- "!entry_point!" !ARGS! 2>>"!STDERR_CAPTURE!"
    ) else (
        "!JS_BINARY__NODE_BINARY!" --require "!launcher!" !JS_BINARY__NODE_OPTIONS! -- "!entry_point!" !ARGS!
    )
)
set "RESULT=!ERRORLEVEL!"

rem ==============================================================================
rem Mop up after main program
rem ==============================================================================

if defined JS_BINARY__EXPECTED_EXIT_CODE (
    if !RESULT! neq !JS_BINARY__EXPECTED_EXIT_CODE! (
        call :logf_error "expected exit code to be '!JS_BINARY__EXPECTED_EXIT_CODE!', but got '!RESULT!'"
        if !RESULT! equ 0 (
            rem This exit code is handled specially by Bazel:
            rem https://github.com/bazelbuild/bazel/blob/486206012a664ecb20bdb196a681efc9a9825049/src/main/java/com/google/devtools/build/lib/util/ExitCode.java#L44
            set "_exit_code=3"
            goto :cleanup_and_exit
        )
        set "_exit_code=!RESULT!"
        goto :cleanup_and_exit
    ) else (
        set "_exit_code=0"
        goto :cleanup_and_exit
    )
)

if defined _exit_code_output_file (
    rem Exit zero if the exit code was captured. Write it with no trailing newline.
    <nul set /p "=!RESULT!">"!_exit_code_output_file!"
    set "_exit_code=0"
    goto :cleanup_and_exit
) else (
    set "_exit_code=!RESULT!"
    goto :cleanup_and_exit
)
