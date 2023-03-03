const std = @import("std");

const json = @import("json");
const quicktype = @import("quicktype.zig");

pub fn main() !void {
    var args = std.process.args();
    const file_name = blk: {
        _ = args.next(); // Skip program name.
        break :blk args.next() orelse unreachable;
    };

    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    var allocator = gpa.allocator();

    var json_file = try std.fs.cwd().openFile(file_name, .{});
    defer json_file.close();
    const size = (try json_file.stat()).size;

    var json_buffer: []u8 = allocator.alloc(u8, size) catch unreachable;
    defer allocator.free(json_buffer);
    const bytes_read = try json_file.read(json_buffer);

    if (bytes_read != size) {
        std.debug.print("Failed to read all bytes.", .{});
    }

    try test_model(allocator, json_buffer);
}

fn test_model(allocator: std.mem.Allocator, json_buffer: []const u8) !void {
    const model = json.fromSlice(allocator, quicktype.TopLevel, json_buffer) catch |e| {
        return std.debug.print("Failed to deserialize: {any}.", .{e});
    };
    const string = json.toSlice(allocator, model) catch |e| {
        return std.debug.print("Failed to serialize: {any}", .{e});
    };
    std.io.getStdOut().writer().writeAll(string) catch |e| {
        return std.debug.print("Failed to write to stdout: {any}", .{e});
    };
}
