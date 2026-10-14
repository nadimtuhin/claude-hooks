package main

import "strings"

// A port of node:path's posix functions, so paths print exactly as the hook prints them.

func normalizeSegments(path string, allowAboveRoot bool) string {
	var res []string
	for _, seg := range strings.Split(path, "/") {
		switch seg {
		case "", ".":
		case "..":
			if len(res) > 0 && res[len(res)-1] != ".." {
				res = res[:len(res)-1]
			} else if allowAboveRoot {
				res = append(res, "..")
			}
		default:
			res = append(res, seg)
		}
	}
	return strings.Join(res, "/")
}

func pathNormalize(p string) string {
	if p == "" {
		return "."
	}
	isAbsolute := p[0] == '/'
	trailing := p[len(p)-1] == '/'
	out := normalizeSegments(p, !isAbsolute)
	if out == "" {
		if isAbsolute {
			return "/"
		}
		if trailing {
			return "./"
		}
		return "."
	}
	if trailing {
		out += "/"
	}
	if isAbsolute {
		return "/" + out
	}
	return out
}

func pathJoin(parts ...string) string {
	var nonEmpty []string
	for _, p := range parts {
		if p != "" {
			nonEmpty = append(nonEmpty, p)
		}
	}
	if len(nonEmpty) == 0 {
		return "."
	}
	return pathNormalize(strings.Join(nonEmpty, "/"))
}

// processCwd is stubbed in tests; the real value is set in main.
var processCwd = func() string { return "/" }

func pathResolve(parts ...string) string {
	resolved := ""
	absolute := false
	for i := len(parts) - 1; i >= -1 && !absolute; i-- {
		var p string
		if i >= 0 {
			p = parts[i]
		} else {
			p = processCwd()
		}
		if p == "" {
			continue
		}
		resolved = p + "/" + resolved
		absolute = p[0] == '/'
	}
	out := normalizeSegments(resolved, !absolute)
	if absolute {
		return "/" + out
	}
	if out == "" {
		return "."
	}
	return out
}

func pathDirname(p string) string {
	if p == "" {
		return "."
	}
	hasRoot := p[0] == '/'
	end := -1
	matchedSlash := true
	for i := len(p) - 1; i >= 1; i-- {
		if p[i] == '/' {
			if !matchedSlash {
				end = i
				break
			}
		} else {
			matchedSlash = false
		}
	}
	if end == -1 {
		if hasRoot {
			return "/"
		}
		return "."
	}
	if hasRoot && end == 1 {
		return "//"
	}
	return p[:end]
}

func pathBasename(p string) string {
	end := len(p)
	for end > 0 && p[end-1] == '/' {
		end--
	}
	if end == 0 {
		return ""
	}
	start := strings.LastIndexByte(p[:end], '/') + 1
	return p[start:end]
}

func pathExtname(p string) string {
	base := pathBasename(p)
	dot := strings.LastIndexByte(base, '.')
	if dot <= 0 || base == ".." {
		return ""
	}
	return base[dot:]
}

func pathRelative(from, to string) string {
	from, to = pathResolve(from), pathResolve(to)
	if from == to {
		return ""
	}
	split := func(s string) []string {
		if s == "/" {
			return nil
		}
		return strings.Split(s[1:], "/")
	}
	f, t := split(from), split(to)
	i := 0
	for i < len(f) && i < len(t) && f[i] == t[i] {
		i++
	}
	var out []string
	for range f[i:] {
		out = append(out, "..")
	}
	out = append(out, t[i:]...)
	return strings.Join(out, "/")
}
