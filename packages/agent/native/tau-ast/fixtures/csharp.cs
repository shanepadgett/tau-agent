global using System;
using System.Collections.Generic;
using Text = System.String;
using static System.Math;

namespace Fixture.Parsing;

/// <summary>Parses source values.</summary>
public interface IParser<T> where T : class
{
    Result Parse(T source);
    string Name { get; }
    event EventHandler? Changed;
}

public readonly record struct Result(bool Ok, string? Message);

public enum State
{
    Ready,
    Failed = 2,
}

public delegate Result ParserDelegate<in T>(T source) where T : class;

[Serializable]
public sealed partial class FileParser<T> : IParser<T> where T : class
{
    public const int DefaultLimit = 10;
    private static readonly Dictionary<string, int> Counts = new();
    public Text Source { get; private set; } = string.Empty;
    public event EventHandler? Changed;
    public event EventHandler? Detailed
    {
        add { Changed += value; }
        remove { Changed -= value; }
    }

    public T this[int index] => throw new NotSupportedException();

    public FileParser(Text source)
    {
        Source = source;
    }

    public Result Parse(T source)
    {
        _ = Abs(Source.Length);
        return new Result(source is not null, null);
    }

    Result IParser<T>.Parse(T source) => Parse(source);

    public static FileParser<T> operator +(FileParser<T> parser, Text suffix) => parser;
    public static explicit operator Text(FileParser<T> parser) => parser.Source;

    public sealed class Nested
    {
        public void Reset() { }
        private void Hide() { }
    }
}

internal sealed class HiddenParser { }
