using System;

public interface IParser
{
    Result Parse(string source);
}

public record Result(bool Ok);

public sealed class FileParser : IParser
{
    public string Source { get; private set; } = string.Empty;

    public Result Parse(string source)
    {
        Source = source.Trim();
        return new Result(Source.Length > 0);
    }
}
