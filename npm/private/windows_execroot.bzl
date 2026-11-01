"""Absolute execution root for the directory symlinks rules_js declares on Windows.

On Windows, Bazel creates every directory symlink (`ctx.actions.symlink(target_type = "directory")`
or a symlink whose target is a directory) as a junction. Junctions cannot be relative, so
WindowsFileSystem resolves the declared relative target against the link's parent and writes an
ABSOLUTE target. When a remote or disk cache is configured, actions run against
RemoteActionFileSystem, which records the declared (relative) target text in its in-memory output
tree and derives the output metadata from it, whereas the next build's output check
(`--experimental_check_output_files`, the default) reads the junction from disk and gets the
absolute target. The digests differ, so every such symlink action is re-executed on every build.

Declaring the absolute target (the exact text Bazel writes into the junction) keeps both views
identical. The execution root is only known to repository rules, so this repository records it;
the symlink rules read it through a private attribute. The value is empty on other platforms, where
the targets stay relative.
"""

WindowsExecrootInfo = provider(
    doc = "Absolute execution root on a Windows host, empty elsewhere.",
    fields = {"path": "Absolute execution root with forward slashes, or \"\""},
)

def _windows_execroot_info_impl(ctx):
    return [WindowsExecrootInfo(path = ctx.attr.path)]

windows_execroot_info = rule(
    implementation = _windows_execroot_info_impl,
    attrs = {"path": attr.string()},
    provides = [WindowsExecrootInfo],
)

def _windows_execroot_repo_impl(rctx):
    path = ""
    if rctx.os.name.lower().startswith("windows"):
        # This repository lives at <output_base>/external/<name>; the main repository's execution
        # root is <output_base>/execroot/_main (Bzlmod).
        path = str(rctx.path(".").dirname.dirname) + "/execroot/_main"
    rctx.file("BUILD.bazel", """\
load("@aspect_rules_js//npm/private:windows_execroot.bzl", "windows_execroot_info")

windows_execroot_info(
    name = "execroot",
    path = {path},
    visibility = ["//visibility:public"],
)
""".format(path = repr(path)))

windows_execroot_repo = repository_rule(
    implementation = _windows_execroot_repo_impl,
    # Depends on the output base location, not on any input: never cache the contents.
    local = True,
)

def _windows_execroot_extension_impl(_mctx):
    windows_execroot_repo(name = "aspect_rules_js_windows_execroot")

windows_execroot = module_extension(implementation = _windows_execroot_extension_impl)

WINDOWS_EXECROOT_ATTR = attr.label(
    default = "@aspect_rules_js_windows_execroot//:execroot",
    providers = [WindowsExecrootInfo],
)

def windows_symlink_target(ctx, symlink, relative_target):
    """Returns the target text to declare for the directory symlink `symlink`.

    Args:
        ctx: rule context of a rule with the `_windows_execroot` attribute
        symlink: the declared symlink File
        relative_target: target relative to the symlink's parent directory

    Returns:
        `relative_target`, or the normalized absolute target on a Windows host.
    """
    execroot = ctx.attr._windows_execroot[WindowsExecrootInfo].path
    if not execroot:
        return relative_target
    segments = []
    for s in (symlink.dirname + "/" + relative_target).split("/"):
        if s == "..":
            segments.pop()
        elif s and s != ".":
            segments.append(s)
    return execroot + "/" + "/".join(segments)
