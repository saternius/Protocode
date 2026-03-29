// ProtoCode Syntax Highlighting Demo
// This file exercises all token types ww

const PI = 3.14159;
let counter = 0;
var legacy = 0xff;

function greet(name) {
  const message = `Hello, ${name}!`;
  console.log(message);
  return message;
}

const add = (a, b) => a + b;

class Vector {
  constructor(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  magnitude() {
    return Math.sqrt(this.x ** 2 + this.y ** 2 + this.z ** 2);
  }
}

// Destructuring and spread
const { x, y } = new Vector(1, 2, 3);
const nums = [1, 2, 3, ...Array(4).fill(0)];

// Control flow
if (counter === 0) {
  for (let i = 0; i < 10; i++) {
    counter += i;
  }
} else {
  while (counter > 0) {
    counter--;
  }
}

// Strings: single, double, template
const single = 'single quotes';
const double = "double quotes";
const template = `result is ${add(1.5, 2e3)}`;

// Booleans, null, undefined
const flags = { active: true, paused: false, data: null };
const missing = undefined;

// Switch and ternary
const label = counter > 5 ? 'high' : 'low';
switch (label) {
  case 'high': break;
  case 'low': break;
  default: break;
}

// Async/await and try/catch
async function fetchData(url) {
  try {
    const response = await fetch(url);
    return await response.json();
  } catch (error) {
    throw new Error(`Failed: ${error.message}`);
  } finally {
    console.log('done');
  }
}

// Regex
const pattern = /^hello\s+world$/gi;
