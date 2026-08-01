using System;
using System.Collections.Generic;

namespace Demo;

/// <summary>Greeter</summary>
public class Greeter : IGreeter
{
	private int count;

	public string Name { get; set; } = "";

	public Greeter() {}

	public Greeter(string name)
	{
		Name = name;
	}

	public void Hello()
	{
		count += 1;
	}

	public event EventHandler? Done;

	public string this[int index] => Name;
}

internal struct Box
{
	public int Value;
}

public interface IGreeter
{
	void Hello();
}

public enum Color
{
	Red,
	Green,
}

public record Person(string Name);

public delegate void Notify(string message);

static class Helpers
{
	public static IEnumerable<int> Range(int n) => System.Linq.Enumerable.Range(0, n);
}
