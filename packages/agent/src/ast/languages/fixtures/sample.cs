using System;

namespace Demo;

/// <summary>Greeter</summary>
public class Greeter {
    private int count;
    public string Name { get; set; }
    public Greeter() {}
    public void Hello() {}
    public event EventHandler Done;
}

internal struct Box {}
public interface IGreeter { void Hello(); }
public enum Color { Red, Green }
public record Person(string Name);
